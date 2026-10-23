import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

const home = () => env.NU_HOME ?? join(homedir(), ".nu");
export const clientConfigPath = () => join(home(), "client.json");

function connection() {
  const path = clientConfigPath();
  const config = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as {
        url?: string;
        token?: string;
      })
    : {};
  const url = env.NU_GATEWAY_URL ?? config.url ?? "http://127.0.0.1:4122";
  if (!/^https?:\/\//.test(url))
    throw new Error("Gateway URL must use http:// or https://");
  let token = config.token;
  if (!token) {
    try {
      token = readFileSync(
        join(home(), "secrets", "terminal_token"),
        "utf8",
      ).trim();
    } catch {
      throw new Error(
        "Nu has not started yet. Start Docker Compose or configure ~/.nu/client.json.",
      );
    }
  }
  if (!token) throw new Error("Missing terminal token");
  return {
    base: url.replace(/\/$/, ""),
    headers: { authorization: `Bearer ${token}` },
  };
}

export async function request(
  route: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
) {
  const { base, headers } = connection();
  const response = await fetch(`${base}/terminal/${route}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  }).catch((error) => {
    if (signal?.aborted) throw error;
    throw new Error("Cannot reach the gateway. Is Nu running?");
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return response;
}

export async function* frames(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("Empty gateway response");
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(
    new TextDecoderStream(),
  )) {
    buffer += chunk;
    buffer = buffer.replace(/\r\n/g, "\n");
    while (buffer.includes("\n\n")) {
      const end = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}
