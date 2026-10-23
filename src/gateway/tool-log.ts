import type {
  ChannelAdapter,
  MessageRef,
  ReplyTarget,
  TurnEvent,
} from "./channel.js";

type ToolEvent = Extract<TurnEvent, { type: "tool" }>;

const ICONS: Record<ToolEvent["status"], string> = {
  running: "⏳",
  waiting: "⏸️",
  done: "✓",
  failed: "✗",
  denied: "⛔",
};
const DIFF_LINES = 30;

const oneLine = (text: string) => {
  const line = text.split("\n").filter(Boolean).join(" · ");
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};
// A fence inside a code block would end it early.
const fenced = (lang: string, lines: string[]) =>
  `\`\`\`${lang}\n${lines.join("\n").replaceAll("```", "`​``")}\n\`\`\``;

function clip(lines: string[]) {
  return lines.length > DIFF_LINES
    ? [
        ...lines.slice(0, DIFF_LINES),
        `… ${lines.length - DIFF_LINES} more lines`,
      ]
    : lines;
}

function change(event: ToolEvent) {
  const args = (event.args ?? {}) as Record<string, unknown>;
  if (event.name === "write") {
    const lines = String(args.content ?? "")
      .replace(/\n$/, "")
      .split("\n");
    return {
      stat: `${lines.length} lines`,
      body: clip(lines.map((l) => `+${l}`)),
    };
  }
  const diff = (event.result as { details?: { diff?: unknown } } | undefined)
    ?.details?.diff;
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  const lines =
    typeof diff === "string"
      ? diff.split("\n")
      : edits.flatMap((edit: Record<string, unknown>) => [
          ...String(edit.oldText ?? "")
            .split("\n")
            .map((l) => `-${l}`),
          ...String(edit.newText ?? "")
            .split("\n")
            .map((l) => `+${l}`),
        ]);
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  return { stat: `+${added} -${removed}`, body: clip(lines) };
}

type Block = { ref?: MessageRef; ids: string[] };

export class ToolLog {
  #current?: Block;
  #blocks = new Map<string, Block>();
  #lines = new Map<string, string>();
  #cards = new Map<string, MessageRef>();
  #dirty = new Set<Block>();
  #timer?: NodeJS.Timeout;
  #flushing = Promise.resolve();

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly target: ReplyTarget,
  ) {}

  get open() {
    return Boolean(this.#current);
  }

  async update(event: ToolEvent) {
    const line = `${ICONS[event.status]} ${oneLine(event.summary)}`;
    if (event.name === "edit" || event.name === "write") {
      const { stat, body } = change(event);
      const text = `${line} (${stat})\n${fenced("diff", body)}`;
      const card = this.#cards.get(event.id);
      if (card) {
        await this.#queue(() => this.adapter.edit(card, text));
        return;
      }
      await this.seal();
      this.#cards.set(event.id, await this.adapter.reply(this.target, text));
      return;
    }
    this.#lines.set(event.id, line);
    let block = this.#blocks.get(event.id);
    if (!block) {
      const length = (this.#current?.ids ?? [])
        .map((id) => this.#lines.get(id) ?? "")
        .concat(line)
        .join("\n").length;
      if (length > this.adapter.limits.maxMessageLength) await this.seal();
      this.#current ??= { ids: [] };
      block = this.#current;
      block.ids.push(event.id);
      this.#blocks.set(event.id, block);
    }
    this.#dirty.add(block);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, this.adapter.limits.minEditIntervalMs);
  }

  async seal() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#current = undefined;
    await this.#flush();
  }

  #flush() {
    const blocks = [...this.#dirty];
    this.#dirty.clear();
    for (const block of blocks) this.#queue(() => this.#show(block));
    return this.#flushing;
  }

  #queue(task: () => Promise<unknown>) {
    this.#flushing = this.#flushing.then(task).then(
      () => {},
      (error) => console.error("gateway: tool log update failed", error),
    );
    return this.#flushing;
  }

  async #show(block: Block) {
    const text = block.ids.map((id) => this.#lines.get(id) ?? "").join("\n");
    if (block.ref) await this.adapter.edit(block.ref, text);
    else block.ref = await this.adapter.reply(this.target, text);
  }
}
