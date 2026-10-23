import type { Event } from "rebuno";
import type { TurnEvent, TurnHandler } from "./channel.js";

export type HistoryEntry =
  | { type: "user" | "note"; text: string }
  | { type: "event"; turn: string; event: TurnEvent };

export const deltaLine = (type: "text" | "thinking", delta: string) =>
  `data: ${JSON.stringify({ type, delta })}\n`;

// Deltas can split a line anywhere, so only complete lines are parsed.
export function streamedContent(raw: string) {
  let text = "";
  let thinking = "";
  const lines = raw.split("\n");
  lines.pop();
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5));
    if (event.type === "text") text += event.delta;
    else if (event.type === "thinking") thinking += event.delta;
  }
  return { text, thinking };
}

const TOOL_STATUS: Record<
  string,
  Extract<TurnEvent, { type: "tool" }>["status"]
> = {
  "step.proposed": "running",
  "step.executing": "running",
  "step.awaiting_approval": "waiting",
  "step.succeeded": "done",
  "step.failed": "failed",
  "step.cancelled": "failed",
  "step.denied": "denied",
};

export class TurnEvents {
  #stepId?: string;
  readonly #tools = new Map<
    string,
    { target: string; args: unknown; result?: unknown; error?: unknown }
  >();
  readonly #raw = new Map<string, string>();
  readonly #content = new Map<string, ReturnType<typeof streamedContent>>();

  constructor(private readonly handler: TurnHandler) {}

  async stream(stepId: string, data: string) {
    if (this.#stepId && this.#stepId !== stepId) {
      await this.handler.event({ type: "text", text: "" });
      await this.handler.event({ type: "thinking", text: "" });
    }
    this.#stepId = stepId;
    const raw = (this.#raw.get(stepId) ?? "") + data;
    this.#raw.set(stepId, raw);
    const content = streamedContent(raw);
    const previous = this.#content.get(stepId);
    this.#content.set(stepId, content);
    if (content.thinking !== (previous?.thinking ?? ""))
      await this.handler.event({ type: "thinking", text: content.thinking });
    if (content.text !== (previous?.text ?? ""))
      await this.handler.event({ type: "text", text: content.text });
  }

  async kernel(
    event: Event,
    getTool: (id: string) => Promise<{
      target: string;
      args: unknown;
      result?: unknown;
      error?: unknown;
    }>,
  ) {
    if (event.type === "execution.blocked")
      return this.handler.event({ type: "paused" });
    const status = TOOL_STATUS[event.type];
    const payload = event.payload as {
      step_id?: string;
      step_type?: string;
      target?: string;
    };
    if (!status || !payload.step_id) return;
    if (payload.step_type === "local") {
      if (payload.target === "compaction")
        await this.handler.event({
          type: "compaction",
          status:
            status === "done"
              ? "done"
              : status === "running"
                ? "running"
                : "failed",
        });
      return;
    }
    if (payload.step_type !== "tool_call") return;
    const final = status === "done" || status === "failed";
    let step = this.#tools.get(payload.step_id);
    if (!step || final) {
      step = await getTool(payload.step_id);
      this.#tools.set(payload.step_id, step);
    }
    await this.handler.event({
      type: "tool",
      id: payload.step_id,
      name: step.target,
      summary: summarize(step.target, step.args as Record<string, unknown>),
      status,
      args: step.args,
      ...(final && { result: step.result, error: step.error }),
    });
  }
}

export function finished(
  execution: { status: string; output: unknown; failureReason?: string },
  turn: { quiet: boolean; silent?: boolean; trigger?: string },
): TurnEvent {
  const status =
    execution.status === "completed"
      ? "completed"
      : execution.status === "cancelled"
        ? "cancelled"
        : "failed";
  const output = execution.output as { reply?: string } | null;
  return {
    type: "finished",
    status,
    text: turn.silent
      ? ""
      : status === "completed"
        ? output?.reply
          ? `${turn.trigger ? `[${turn.trigger}] ` : ""}${output.reply}`
          : turn.quiet
            ? ""
            : "(no reply)"
        : status === "cancelled"
          ? "Stopped."
          : `The turn failed: ${execution.failureReason}`,
  };
}

export function summarize(target: string, args: Record<string, unknown>) {
  switch (target) {
    case "shell":
      return `Run \`${args.command}\``;
    case "write":
    case "edit":
      return `${target === "write" ? "Write" : "Edit"} ${args.path}`;
    case "read":
      return `Read ${args.path}`;
    case "message_send":
      return `Message ${args.to}: ${String(args.text).slice(0, 1500)}${Array.isArray(args.files) && args.files.length ? `\nFiles: ${args.files.join(", ")}` : ""}`;
    case "background_task":
      return `Start background task "${args.title}": ${String(args.instructions).slice(0, 1500)}`;
    case "delegate":
      return `Delegate to ${args.specialist}${args.wait === false ? " (in its own conversation)" : ""}: ${String(args.task).slice(0, 1500)}`;
    case "package_remove":
      return `Remove package ${args.source}`;
    case "package_checkout":
      return `Check out package ${args.namespace}`;
    case "package_write":
      return `Write package ${args.namespace}`;
    case "browser_task":
      return `Browser task in profile ${args.profile ?? "default"}: ${String(args.task).slice(0, 1500)}`;
    case "skill_write":
      return `${String(args.body ?? "").trim() ? "Write" : "Delete"} skill ${args.name}: ${String(args.description ?? "").slice(0, 300)}`;
    case "browser_handoff":
      return `Complete a step in browser profile ${args.profile ?? "default"}: ${args.reason}`;
    case "browser_submit":
      return `Submit on ${args.site}: ${args.action}\n${String(args.summary).slice(0, 1500)}`;
    default: {
      const title = target.replaceAll("_", " ").replace(/ +/g, " ");
      return [
        title.charAt(0).toUpperCase() + title.slice(1),
        ...Object.entries(args).map(
          ([key, value]) =>
            `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        ),
      ]
        .join("\n")
        .slice(0, 1500);
    }
  }
}
