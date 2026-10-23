import type {
  ChannelAdapter,
  MessageRef,
  ReplyTarget,
  TurnHandler,
} from "./channel.js";
import { ToolLog } from "./tool-log.js";

class Reply {
  #text = "";
  #shown = "";
  #ref?: MessageRef;
  #timer?: NodeJS.Timeout;
  #flushing = Promise.resolve();

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly target: ReplyTarget,
  ) {}

  update(text: string) {
    this.#text = text;
    if (!this.adapter.supportsEdits || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#flushing.then(() => this.#show(this.#text));
    }, this.adapter.limits.minEditIntervalMs);
  }

  async #show(text: string) {
    const max = this.adapter.limits.maxMessageLength;
    const shown = text.length > max ? `${text.slice(0, max - 1)}…` : text;
    if (shown === this.#shown) return;
    this.#shown = shown;
    if (this.#ref) await this.adapter.edit(this.#ref, shown);
    else this.#ref = await this.adapter.reply(this.target, shown);
  }

  async pause() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#flushing;
    if (this.#text) await this.#show(this.#text);
    this.#ref = undefined;
    this.#text = "";
    this.#shown = "";
  }

  async finish(text: string) {
    clearTimeout(this.#timer);
    await this.#flushing;
    if (!text) return;
    const [first, ...rest] = split(text, this.adapter.limits.maxMessageLength);
    if (this.#ref) await this.adapter.edit(this.#ref, first);
    else await this.adapter.reply(this.target, first);
    for (const part of rest) await this.adapter.reply(this.target, part);
  }
}

export function textTurn(
  adapter: ChannelAdapter,
  target: ReplyTarget,
): TurnHandler {
  const reply = new Reply(adapter, target);
  const tools = adapter.supportsEdits
    ? new ToolLog(adapter, target)
    : undefined;
  let typing: NodeJS.Timeout | undefined;
  let compactions = 0;
  let compacting = false;
  const startTyping = () => {
    if (!adapter.typing || typing) return;
    const renew = () => adapter.typing?.(target).catch(() => {});
    renew();
    typing = setInterval(renew, 8000).unref();
  };
  const stopTyping = () => {
    clearInterval(typing);
    typing = undefined;
  };
  startTyping();
  return {
    async event(event) {
      if (event.type === "approval" || event.type === "finished") stopTyping();
      else startTyping();
      switch (event.type) {
        case "text":
          if (!event.text) break;
          await tools?.seal();
          reply.update(event.text);
          break;
        case "tool":
          if (!tools) break;
          await reply.pause();
          await tools.update(event);
          break;
        case "compaction":
          if (tools) {
            await reply.pause();
            await tools.update({
              type: "tool",
              id: `compaction-${compactions}`,
              name: "compaction",
              summary:
                event.status === "running"
                  ? "Compacting conversation…"
                  : event.status === "done"
                    ? "Conversation compacted"
                    : "Conversation compaction failed",
              status: event.status,
              args: {},
            });
            if (event.status !== "running") compactions++;
          } else if (event.status === "running" && !compacting) {
            await reply.pause();
            await adapter.reply(target, "Compacting conversation…");
          }
          compacting = event.status === "running";
          break;
        case "paused":
          await reply.pause();
          break;
        case "approval":
          await tools?.seal();
          await reply.pause();
          await adapter.postApproval(target, event.approval);
          break;
        case "finished":
          await tools?.seal();
          await reply.finish(event.text);
          break;
      }
    },
  };
}

export function split(text: string, max: number) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}
