import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, execution, type Idempotency } from "rebuno";

// biome-ignore lint/suspicious/noExplicitAny: a tool of any schema
export type AnyTool = AgentTool<any>;

export type NuTool = AnyTool & {
  stepArgs?: (params: unknown) => Promise<Record<string, unknown>>;
  before?: (params: unknown) => Promise<void>;
};

export const anyTool = <T extends TSchema>(tool: AgentTool<T>): AnyTool => tool;

export const text = (value: string): AgentToolResult<undefined> => ({
  content: [{ type: "text", text: value }],
  details: undefined,
});

// A call held for approval, or refused because the execution ended, suspends
// the turn; onSuspend stops the loop so no further model call is made.
export function asStep(
  tool: NuTool,
  idempotency: Idempotency,
  onSuspend: (error: unknown) => void,
): AnyTool {
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const run = defineTool({
        name: tool.name,
        idempotency,
        execute: () => tool.execute(id, params, signal, onUpdate),
      });
      try {
        await tool.before?.(params);
        const result = await run(
          tool.stepArgs
            ? await tool.stepArgs(params)
            : (params as Record<string, unknown>),
        );
        if (typeof result === "string")
          return { ...text(result), isError: true };
        if (Array.isArray((result as { content?: unknown })?.content))
          return result as AgentToolResult<unknown>;
        const reply = (result as { reply?: unknown } | null)?.reply;
        return text(
          typeof reply === "string" ? reply : JSON.stringify(result ?? null),
        );
      } catch (error) {
        if (execution().suspension) onSuspend(error);
        throw error;
      }
    },
  };
}
