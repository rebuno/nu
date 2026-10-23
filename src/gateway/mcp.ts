import { env } from "node:process";

import { readServers } from "../mcp.js";

const RUNNER_URL = "http://127.0.0.1:4119";

export async function mcpStatus() {
  let listed: { tools: { name: string }[]; errors: Record<string, string> };
  let unchecked: string | undefined;
  try {
    const response = await fetch(`${RUNNER_URL}/mcp/tools`, {
      headers: { authorization: `Bearer ${env.RUNNER_SECRET ?? ""}` },
    });
    listed = await response.json();
    if (!response.ok)
      throw new Error(String((listed as { error?: unknown }).error));
  } catch (error) {
    listed = { tools: [], errors: {} };
    unchecked = `not checked: ${error instanceof Error ? error.message : error}`;
  }
  return Object.entries(readServers()).map(([name, value]) => {
    const server = (value ?? {}) as Record<string, unknown>;
    const prefix = `mcp__${name}__`;
    return {
      name,
      target:
        typeof server.url === "string"
          ? server.url
          : [server.command, ...((server.args as unknown[]) ?? [])].join(" "),
      tools: listed.tools
        .filter((tool) => tool.name.startsWith(prefix))
        .map((tool) => tool.name.slice(prefix.length)),
      error: unchecked ?? listed.errors[name],
    };
  });
}
