import { env } from "node:process";

import type { TSchema } from "@earendil-works/pi-ai";
import { execution, type Idempotency } from "rebuno";

import type { Manifest } from "../../registry.js";
import { type NuTool, text } from "./tool.js";

const RUNNER_URL = "http://127.0.0.1:4119";

export type Pinned = Pick<
  Manifest,
  "name" | "description" | "args_schema" | "idempotency"
> & { version?: number };

const runnerHeaders = {
  authorization: `Bearer ${env.RUNNER_SECRET ?? ""}`,
  "content-type": "application/json",
};

export async function mcpTools(): Promise<{
  tools: Pinned[];
  servers: Record<string, string>;
}> {
  try {
    const response = await fetch(`${RUNNER_URL}/mcp/tools`, {
      headers: runnerHeaders,
    });
    const outcome = await response.json();
    if (!response.ok) throw new Error(outcome.error);
    return outcome;
  } catch (error) {
    console.error("agent: listing MCP tools failed", error);
    return { tools: [], servers: {} };
  }
}

export function registeredTool(pinned: Pinned): [NuTool, Idempotency] {
  const tool: NuTool = {
    name: pinned.name,
    label: pinned.name,
    description: pinned.description,
    parameters: pinned.args_schema as unknown as TSchema,
    execute: async (_id, args, signal) => {
      const response = await fetch(`${RUNNER_URL}/run`, {
        method: "POST",
        signal,
        headers: runnerHeaders,
        body: JSON.stringify({
          execution_id: execution().id,
          tool: pinned.name,
          version: pinned.version,
          args,
        }),
      });
      const outcome = await response.json();
      if (!response.ok) throw new Error(outcome.error);
      return text(
        typeof outcome.result === "string"
          ? outcome.result
          : JSON.stringify(outcome.result, null, 2),
      );
    },
  };
  return [tool, pinned.idempotency];
}
