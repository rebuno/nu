import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { MCP_PATH } from "./config.js";
import { NAMESPACE } from "./registry.js";

export type McpServer = { description?: string } & (
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | { url: string; headers?: Record<string, string> }
);

const readFile = (): { mcpServers?: Record<string, unknown> } =>
  existsSync(MCP_PATH) ? JSON.parse(readFileSync(MCP_PATH, "utf8")) : {};

export const readServers = () => readFile().mcpServers ?? {};

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isTextRecord = (value: unknown) =>
  value === undefined ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string"));

export function validateServer(name: string, value: unknown): McpServer {
  const fail = (problem: string) => {
    throw new Error(`MCP server ${name}: ${problem}`);
  };
  if (!NAMESPACE.test(name)) fail("names are lowercase letters, digits, and -");
  const s = (value ?? {}) as Record<string, unknown>;
  if (s.description !== undefined && !isText(s.description))
    fail("description must be text");
  if ("url" in s === "command" in s) fail("set either command or url");
  if ("url" in s) {
    if (!isText(s.url) || !/^https?:\/\//.test(s.url))
      fail("url must be http(s)");
    if (!isTextRecord(s.headers)) fail("headers must map names to text");
    return {
      url: s.url as string,
      ...(s.headers ? { headers: s.headers as Record<string, string> } : {}),
      ...(s.description ? { description: s.description as string } : {}),
    };
  }
  if (!isText(s.command)) fail("command must be text");
  if (
    s.args !== undefined &&
    !(Array.isArray(s.args) && s.args.every((arg) => typeof arg === "string"))
  )
    fail("args must be a list of text");
  if (!isTextRecord(s.env)) fail("env must map names to text");
  if (s.cwd !== undefined && !isText(s.cwd)) fail("cwd must be text");
  return {
    command: s.command as string,
    ...(s.args ? { args: s.args as string[] } : {}),
    ...(s.env ? { env: s.env as Record<string, string> } : {}),
    ...(s.cwd ? { cwd: s.cwd as string } : {}),
    ...(s.description ? { description: s.description as string } : {}),
  };
}

export function writeServer(name: string, server?: McpServer) {
  const file = readFile();
  const { [name]: _, ...servers } = file.mcpServers ?? {};
  writeFileSync(
    MCP_PATH,
    `${JSON.stringify(
      {
        ...file,
        mcpServers: server ? { ...servers, [name]: server } : servers,
      },
      null,
      2,
    )}\n`,
  );
}
