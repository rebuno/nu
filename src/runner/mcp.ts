import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Idempotency } from "rebuno";

import pkg from "../../package.json" with { type: "json" };
import { type McpServer, readServers, validateServer } from "../mcp.js";
import { sandbox } from "../sandbox/index.js";
import { resolveSecrets } from "./secrets.js";

type SourceTool = {
  name: string;
  description: string;
  args_schema: Record<string, unknown>;
  idempotency: Idempotency;
};

const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;

const clients = new Map<string, { key: string; client: Promise<Client> }>();

const SECRET_REF = /\$\{([A-Z][A-Z0-9_]*)\}/g;

async function expand(server: McpServer): Promise<McpServer> {
  const json = JSON.stringify(server);
  const secrets = await resolveSecrets([
    ...new Set(Array.from(json.matchAll(SECRET_REF), (match) => match[1])),
  ]);
  return JSON.parse(json, (_key, value) =>
    typeof value === "string"
      ? value.replace(SECRET_REF, (_match, name: string) => secrets[name])
      : value,
  );
}

function close(name: string) {
  clients
    .get(name)
    ?.client.then((client) => client.close())
    .catch(() => {});
  clients.delete(name);
}

function connect(name: string, server: McpServer) {
  const key = JSON.stringify(server);
  const open = clients.get(name);
  if (open?.key === key) return open.client;
  close(name);
  const client = new Client({ name: "nu", version: pkg.version });
  const transport =
    "url" in server
      ? new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        })
      : new StdioClientTransport({
          ...server,
          env: {
            ...getDefaultEnvironment(),
            NODE_OPTIONS: "--disable-sigusr1",
            ...server.env,
          },
        });
  const entry = {
    key,
    client: client
      .connect(transport, { timeout: LIST_TIMEOUT_MS })
      .then(() => client),
  };
  const forget = () => {
    if (clients.get(name) === entry) clients.delete(name);
  };
  client.onclose = forget;
  entry.client.catch(forget);
  clients.set(name, entry);
  return entry.client;
}

async function serverTools(server: string, value: unknown) {
  const config = validateServer(server, value);
  const client = await connect(server, await expand(config));
  const tools: SourceTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIST_TIMEOUT_MS,
    });
    for (const tool of page.tools) {
      const name = `mcp__${server}__${tool.name}`;
      if (!TOOL_NAME.test(tool.name) || name.length > MAX_NAME_LENGTH) {
        console.warn(`runner: skipping MCP tool ${name}: unusable name`);
        continue;
      }
      const { readOnlyHint, idempotentHint } = tool.annotations ?? {};
      tools.push({
        name,
        description: tool.description || tool.title || tool.name,
        args_schema: tool.inputSchema,
        idempotency:
          readOnlyHint || idempotentHint ? "safe_to_retry" : "at_most_once",
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  const info = client.getServerVersion();
  return {
    tools,
    description: config.description ?? info?.description ?? info?.title,
  };
}

export async function listMcpTools() {
  const servers = readServers();
  for (const name of clients.keys()) if (!(name in servers)) close(name);
  const errors: Record<string, string> = {};
  const listed = await Promise.all(
    Object.entries(servers).map(([server, config]) =>
      serverTools(server, config)
        .then((list) => ({ server, ...list }))
        .catch((error) => {
          errors[server] =
            error instanceof Error ? error.message : String(error);
          console.error(`runner: MCP server ${server}:`, errors[server]);
          return undefined;
        }),
    ),
  );
  const found = listed.filter((list) => list !== undefined);
  return {
    tools: found.flatMap((list) => list.tools),
    servers: Object.fromEntries(
      found.flatMap(({ server, description }) =>
        description ? [[`mcp__${server}`, description]] : [],
      ),
    ),
    errors,
  };
}

async function partText(part: CallToolResult["content"][number], dir: string) {
  if (part.type === "text") return part.text;
  if (part.type === "resource" && "text" in part.resource)
    return part.resource.text;
  if (part.type === "image" || part.type === "audio") {
    const path = join(
      dir,
      `${randomUUID()}.${part.mimeType.split("/")[1]?.split("+")[0]}`,
    );
    await sandbox.writeFile(path, Buffer.from(part.data, "base64"));
    return `[${part.type} saved to ${path}]`;
  }
  return `[${part.type} omitted]`;
}

export async function contentText(
  content: CallToolResult["content"],
  executionId: string,
) {
  const dir = join(sandbox.workdir, "tools", executionId);
  return (await Promise.all(content.map((part) => partText(part, dir)))).join(
    "\n",
  );
}

export async function callMcpTool(
  name: string,
  args: unknown,
  executionId: string,
) {
  const [, server, tool] = name.match(/^mcp__([a-z][a-z0-9-]*)__(.+)$/) ?? [];
  const config = server ? readServers()[server] : undefined;
  if (!config) throw new Error("tool removed");
  const client = await connect(
    server,
    await expand(validateServer(server, config)),
  );
  const result = (await client.callTool(
    { name: tool, arguments: args as Record<string, unknown> },
    undefined,
    { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
  )) as CallToolResult;
  const text = await contentText(result.content, executionId);
  if (result.isError) throw new Error(text || "the tool failed");
  return text || (result.structuredContent ?? null);
}
