import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels, modelKey } from "../agent/models.js";
import { AUTH_PATH, DATA_DIR, MODELS_PATH } from "../config.js";
import { readSettings, writeSettings } from "../settings.js";
import { HttpError } from "./gateway.js";

type Pending = { prompt: AuthPrompt; resolve: (answer: string) => void };
const deviceId = () => {
  const path = join(DATA_DIR, "device_id");
  if (!existsSync(path))
    writeFileSync(path, JSON.stringify(randomUUID()), { mode: 0o600 });
  return JSON.parse(readFileSync(path, "utf8")) as string;
};

export class TerminalLogin {
  readonly #pending = new Map<string, Pending>();
  #active = false;

  answer(id: string, answer: string) {
    const pending = this.#pending.get(id);
    if (!pending) throw new HttpError(404, "login prompt expired");
    if (
      pending.prompt.type === "select" &&
      !pending.prompt.options.some((o) => o.id === answer)
    )
      throw new HttpError(400, "invalid selection");
    this.#pending.delete(id);
    pending.resolve(answer);
  }

  async start(providerId: string | undefined, res: ServerResponse) {
    if (this.#active) throw new HttpError(409, "another login is in progress");
    this.#active = true;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("login expired")),
      15 * 60_000,
    );
    const close = () => controller.abort(new Error("login disconnected"));
    res.on("close", close);
    const send = (event: unknown) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const prompt = async (prompt: AuthPrompt): Promise<string> => {
      // Browser callbacks target the container's loopback, which the host browser cannot reach.
      const deviceCode =
        prompt.type === "select" &&
        prompt.options.find((o) => /^device[-_]code$/.test(o.id));
      if (deviceCode) return deviceCode.id;
      const signal = prompt.signal
        ? AbortSignal.any([controller.signal, prompt.signal])
        : controller.signal;
      signal.throwIfAborted();
      const id = randomUUID();
      const { signal: _, ...view } = prompt;
      return new Promise<string>((resolve, reject) => {
        const abort = () => {
          this.#pending.delete(id);
          send({ type: "prompt_cancelled", id });
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.#pending.set(id, {
          prompt,
          resolve: (answer) => {
            signal.removeEventListener("abort", abort);
            resolve(answer);
          },
        });
        send({ type: "prompt", id, prompt: view });
      });
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const runtime = await ModelRuntime.create({
        authPath: AUTH_PATH,
        modelsPath: MODELS_PATH,
      });
      const providers = runtime
        .getProviders()
        .filter((p) => p.auth.oauth || p.auth.apiKey?.login);
      const provider = providers.find((p) => p.id === providerId);
      if (providerId && !provider)
        throw new HttpError(400, "unknown login provider");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      if (!provider) {
        send({
          type: "providers",
          providers: providers.map((p) => ({ id: p.id, name: p.name })),
        });
        send({ type: "done" });
        return;
      }
      const type =
        provider.auth.oauth && provider.auth.apiKey?.login
          ? ((await prompt({
              type: "select",
              message: `Sign in to ${provider.name} with`,
              options: [
                { id: "oauth", label: "an account" },
                { id: "api_key", label: "an API key" },
              ],
            })) as "oauth" | "api_key")
          : provider.auth.oauth
            ? "oauth"
            : "api_key";
      await runtime.login(
        provider.id,
        type,
        { signal: controller.signal, prompt, notify: send },
        { getDeviceId: deviceId, agentName: "Nu" },
      );
      const models = (await (await createModels()).available()).filter(
        (m) => m.provider === provider.id,
      );
      if (!models.length) {
        send({
          type: "done",
          message: `Signed in to ${provider.name}, which has no models available.`,
        });
        return;
      }
      const key = await prompt({
        type: "select",
        message: "Choose Nu's model",
        options: models.map((m) => ({ id: modelKey(m), label: modelKey(m) })),
      });
      const [, ...id] = key.split("/");
      writeSettings({
        ...readSettings(),
        defaultProvider: provider.id,
        defaultModel: id.join("/"),
      });
      send({
        type: "done",
        message: `Signed in to ${provider.name}. Nu uses ${key}.`,
      });
    } catch (error) {
      if (!res.headersSent) throw error;
      send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      controller.abort();
      res.removeListener("close", close);
      this.#active = false;
      if (res.headersSent) res.end();
    }
  }
}
