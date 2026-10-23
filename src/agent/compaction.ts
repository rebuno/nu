import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
} from "@earendil-works/pi-ai";

const TAIL_TOKENS = 20_000;
const TEMPLATE = `## User
- goals, standing preferences, and constraints the user stated
## Open commitments
- things the assistant said it would do or follow up on, and unanswered questions
## Decisions
- decisions made and why
## Facts
- names, IDs, URLs, numbers, paths, and errors needed to continue, kept exactly
## Recent requests
> the user's own messages from the summarized part, quoted verbatim, newest first, up to ~2,000 tokens`;

function text(message: AgentMessage): string {
  if (message.role === "compactionSummary") return message.summary;
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "toolCall")
        return `${part.name}(${JSON.stringify(part.arguments)})`;
      return "";
    })
    .join("\n");
}

function tokens(message: AgentMessage) {
  return Math.ceil(text(message).length / 4);
}

function estimate(messages: AgentMessage[], model: Model<Api>, saved = 0) {
  const summary = messages.findLast((m) => m.role === "compactionSummary");
  const index = messages.findLastIndex((m) => m.role === "assistant");
  const last = messages[index];
  if (
    last?.role === "assistant" &&
    last.stopReason !== "error" &&
    last.stopReason !== "aborted" &&
    last.provider === model.provider &&
    last.model === model.id &&
    (!summary || last.timestamp > summary.timestamp)
  ) {
    const usage = last.usage;
    const used =
      usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    if (Number.isFinite(used) && used > 0)
      return (
        Math.max(0, used - saved) +
        messages.slice(index + 1).reduce((sum, m) => sum + tokens(m), 0)
      );
  }
  return messages.reduce((sum, m) => sum + tokens(m), 0);
}

function ceiling(model: Model<Api>) {
  return (
    model.contextWindow -
    Math.max(Math.floor(model.contextWindow * 0.1), 16_000)
  );
}

export function needsCompaction(
  messages: AgentMessage[],
  model: Model<Api>,
  saved = 0,
) {
  return (
    model.contextWindow > 0 &&
    estimate(messages, model, saved) >= ceiling(model)
  );
}

function recentStart(messages: AgentMessage[]) {
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    total += tokens(messages[i]);
    if (total > TAIL_TOKENS) return i + 1;
  }
  return 0;
}

function cutPoint(messages: AgentMessage[]) {
  const latestUser = messages.findLastIndex((m) => m.role === "user");
  if (latestUser < 0) return 0;
  const start = recentStart(messages);
  const next = messages.findIndex((m, i) => i >= start && m.role === "user");
  return Math.min(next < 0 ? latestUser : next, latestUser);
}

export function prune(messages: AgentMessage[]): {
  messages: AgentMessage[];
  saved: number;
} {
  const cut = recentStart(messages);
  let removed = 0;
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  const pruned = messages.map((message, i): AgentMessage => {
    if (
      i >= cut ||
      message.role !== "toolResult" ||
      message.toolName === "tool_search" ||
      message.toolName === "memory_search" ||
      text(message).length <= 500
    )
      return message;
    const stub = `[${message.toolName} result removed to save space]`;
    if (i <= lastAssistant)
      removed += tokens(message) - Math.ceil(stub.length / 4);
    return { ...message, content: [{ type: "text", text: stub }] };
  });
  // Only removals before the last assistant correct its reported usage.
  return { messages: pruned, saved: removed };
}

function serialize(message: AgentMessage) {
  if (message.role === "compactionSummary") return message.summary;
  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "toolResult"
  )
    return "";
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
  if (message.role === "user") return `[User] ${content}`;
  if (message.role === "toolResult")
    return `[Tool result] ${content.slice(0, 1500)}`;
  return [
    ...(content ? [`[Assistant] ${content}`] : []),
    ...message.content.flatMap((part) =>
      part.type === "toolCall"
        ? [
            `[Assistant tool call]: ${part.name}(${JSON.stringify(part.arguments)})`,
          ]
        : [],
    ),
  ].join("\n");
}

export async function compactMessages(
  messages: AgentMessage[],
  model: Model<Api>,
  options: {
    saved?: number;
    summaryModel?: Model<Api>;
    summarize: (
      systemPrompt: string,
      messages: Message[],
    ) => Promise<AssistantMessage>;
  },
): Promise<{ summary: string; keepFrom: number; tokensBefore: number } | null> {
  const keepFrom = cutPoint(messages);
  const older = messages.slice(0, keepFrom);
  if (!older.some((m) => m.role !== "compactionSummary")) return null;
  const previous = older.find((m) => m.role === "compactionSummary");
  const history = older.filter((m) => m.role !== "compactionSummary");
  const exchanges: string[] = [];
  for (const message of history) {
    if (message.role === "user" || !exchanges.length)
      exchanges.push(serialize(message));
    else exchanges[exchanges.length - 1] += `\n${serialize(message)}`;
  }
  const budget = (options.summaryModel ?? model).contextWindow - 16_000 - 8_000;
  let omitted = 0;
  const input = () =>
    [
      ...(omitted ? [`[${omitted} older exchanges omitted]`] : []),
      ...(previous ? [`Previous summary:\n${previous.summary}`] : []),
      ...exchanges,
    ].join("\n\n");
  while (Math.ceil(input().length / 4) > budget && exchanges.length) {
    exchanges.shift();
    omitted++;
  }
  if (Math.ceil(input().length / 4) > budget)
    throw new Error("Compaction input exceeds the model's context window");
  const systemPrompt = `Summarize the conversation only. Do not continue the conversation or call tools. Preserve the user's requests and the assistant's commitments. ${previous ? "Update the previous summary; newer history wins when it conflicts. " : ""}Use this template:\n\n${TEMPLATE}`;
  const transcript: Message[] = [
    { role: "user", content: input(), timestamp: Date.now() },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await options.summarize(systemPrompt, transcript);
    if (
      reply.stopReason === "length" ||
      reply.stopReason === "error" ||
      reply.stopReason === "aborted" ||
      reply.content.some((part) => part.type === "toolCall")
    )
      throw new Error("Compaction returned an incomplete or invalid summary");
    const summary = reply.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    if (
      /^## (User|Open commitments|Decisions|Facts|Recent requests)\s*$/m.test(
        summary,
      )
    )
      return {
        summary,
        keepFrom,
        tokensBefore: estimate(messages, model, options.saved),
      };
    transcript.push(reply, {
      role: "user",
      content: `Use the required template headings. Return only the summary.\n\n${TEMPLATE}`,
      timestamp: Date.now(),
    });
  }
  throw new Error("Compaction summary is missing the required headings");
}
