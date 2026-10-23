import { createServer, type Server } from "node:http";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { frames, request } from "./http.js";

type Frame =
  | AuthEvent
  | { type: "prompt"; id: string; prompt: AuthPrompt }
  | { type: "prompt_cancelled"; id: string }
  | { type: "providers"; providers: { id: string; name: string }[] }
  | { type: "done" | "error"; message?: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopbackRedirect(authUrl: string) {
  const params = new URL(authUrl).searchParams;
  const value = params.get("redirect_uri") ?? params.get("callback_url");
  const url = value ? URL.parse(value) : null;
  if (url?.protocol === "http:" && LOOPBACK.has(url.hostname) && url.port)
    return url;
}

const oauthPage = (heading: string, message: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: #09090b; color: #fafafa; font-family: system-ui, sans-serif; }
h1 { margin: 12px 0 0; font-size: 28px; }
p { margin: 0; color: #a1a1aa; }
</style>
</head>
<body>
<svg width="64" height="64" viewBox="-41 139 610 610" fill="#fafafa"><path d="M7.5 233.7L145.1 178.0L168.8 178.0L313.2 600.2L401.0 422.9C421.3 380.7 427.2 355.3 427.2 340.1C427.2 317.3 421.3 287.8 414.5 258.2C411.1 245.6 410.3 237.1 410.3 228.7C410.3 194.9 429.7 178.0 469.4 178.0C504.0 178.0 520.9 194.9 520.9 227.0C520.9 270.9 480.4 355.3 446.6 414.4L292.1 710.0L259.1 710.0L138.4 346.9C128.3 317.3 117.3 292.0 102.9 268.4C87.7 241.3 70.8 246.4 51.4 246.4C37.1 246.4 24.4 250.6 15.9 253.2Z"/></svg>
<h1>${heading}</h1>
<p>${message}</p>
</body>
</html>`;

// Pi's callback listener runs on the gateway's loopback; the browser redirects to this machine.
export function catchRedirect(redirect: URL, deliver: (url: string) => void) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirect.origin);
    const page = (status: number, html: string) =>
      res
        .writeHead(status, { "content-type": "text/html; charset=utf-8" })
        .end(html);
    if (req.method !== "GET" || url.pathname !== redirect.pathname)
      return page(
        404,
        oauthPage("Authentication failed", "Callback route not found."),
      );
    if (!url.searchParams.has("code") && !url.searchParams.has("error"))
      return page(
        400,
        oauthPage("Authentication failed", "Missing authorization code."),
      );
    page(
      200,
      oauthPage(
        "Authentication successful",
        "Nu received the sign-in. You may now close this page.",
      ),
    );
    deliver(url.href);
  });
  server.on("error", () => server.close());
  server.listen(
    Number(redirect.port),
    redirect.hostname.replace(/^\[|\]$/g, ""),
  );
  return server;
}

export async function login(provider?: string) {
  const controller = new AbortController();
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({
    input: stdin,
    output,
    terminal: Boolean(stdin.isTTY),
  });
  const pending = new Map<string, AbortController>();
  let promptTask: Promise<void> = Promise.resolve();
  let failure: unknown;
  let server: Server | undefined;
  let redirected: string | undefined;
  let manual: string | undefined;
  const fail = (error: unknown) => {
    failure = error;
    controller.abort();
  };
  const answerManual = () => {
    if (!redirected || !manual) return;
    const id = manual;
    manual = undefined;
    pending.get(id)?.abort();
    request(
      `login/${id}/answer`,
      { answer: redirected },
      "POST",
      controller.signal,
    ).catch((error) => {
      if (!controller.signal.aborted) fail(error);
    });
  };
  const cancel = () => controller.abort();
  rl.on("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const response = await request(
      "login",
      { provider },
      "POST",
      controller.signal,
    );
    let done = false;
    for await (const value of frames(response)) {
      const event = value as Frame;
      if (event.type === "auth_url") {
        console.log(
          `Open ${event.url}${event.instructions ? `\n${event.instructions}` : ""}`,
        );
        const redirect = loopbackRedirect(event.url);
        if (redirect && !server)
          server = catchRedirect(redirect, (url) => {
            if (redirected) return;
            redirected = url;
            console.log("\nReceived the browser sign-in.");
            answerManual();
          });
      } else if (event.type === "device_code")
        console.log(
          `Open ${event.verificationUri} and enter ${event.userCode}`,
        );
      else if (event.type === "providers")
        console.log(
          `Providers:\n${event.providers.map((p) => `  ${p.id.padEnd(22)} ${p.name}`).join("\n")}`,
        );
      else if (event.type === "prompt_cancelled")
        pending.get(event.id)?.abort();
      else if (event.type === "prompt") {
        const abort = new AbortController();
        pending.set(event.id, abort);
        if (event.prompt.type === "manual_code") {
          manual = event.id;
          answerManual();
        }
        // Keep reading SSE while a prompt is open so a browser callback can cancel it.
        promptTask = promptTask
          .then(async () => {
            if (abort.signal.aborted) return;
            const signal = AbortSignal.any([controller.signal, abort.signal]);
            const prompt = event.prompt;
            console.log(prompt.message);
            if (prompt.type === "select")
              prompt.options.forEach((o, i) => {
                console.log(`  ${i + 1}. ${o.label}`);
              });
            muted = prompt.type === "secret";
            if (muted) stdout.write("Secret: ");
            try {
              let answer = await rl.question(
                prompt.type === "select" ? "Number: " : muted ? "" : "> ",
                { signal },
              );
              if (prompt.type === "select") {
                const option = prompt.options[Number(answer) - 1];
                if (!option) throw new Error("no such option");
                answer = option.id;
              }
              await request(
                `login/${event.id}/answer`,
                { answer },
                "POST",
                controller.signal,
              );
            } catch (error) {
              if (!signal.aborted) throw error;
            } finally {
              if (muted) stdout.write("\n");
              muted = false;
              pending.delete(event.id);
            }
          })
          .catch(fail);
      } else if (event.type === "done") {
        done = true;
        if (event.message) console.log(event.message);
      } else if (event.type === "error") throw new Error(event.message);
      else if (event.type === "info" || event.type === "progress")
        console.log(event.message);
    }
    if (!done) throw new Error("Login disconnected. Run nu login again.");
  } catch (error) {
    throw failure ?? error;
  } finally {
    server?.close();
    controller.abort();
    for (const abort of pending.values()) abort.abort();
    await promptTask;
    rl.close();
    process.removeListener("SIGTERM", cancel);
  }
}
