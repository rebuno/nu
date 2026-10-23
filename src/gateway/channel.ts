export interface Location {
  conversationId: string;
  threadId?: string;
  direct: boolean;
  messageId?: string;
}

export interface InboundMessage extends Location {
  senderId: string;
  messageId: string;
  text: string;
  attachments?: { name: string; url: string }[];
}

export interface Command extends Location {
  senderId: string;
  name: string;
  args: string;
  respond(text: string, view?: ListView): Promise<void>;
}

// A list response for channels that render structure, such as embeds. `text`
// carries the same content for every other channel.
export interface ListView {
  title: string;
  items: { name: string; text: string }[];
  footer?: string;
}

export type ApprovalDecision = "once" | "always" | "rule" | "deny";

export const APPROVAL_DECISIONS: ApprovalDecision[] = [
  "once",
  "always",
  "rule",
  "deny",
];

export interface ApprovalAction {
  senderId: string;
  approvalId: string;
  decision: ApprovalDecision;
  text?: string;
}

// Posting a view with the id of an earlier one updates that card; a view
// without choices has been decided, and its status says how.
export interface ApprovalView {
  id: string;
  target: string;
  summary: string;
  reason: string;
  choices: { decision: ApprovalDecision; label: string }[];
  status?: string;
}

export type ReplyTarget = Location;

export type TurnEvent =
  | { type: "started" }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "compaction"; status: "running" | "done" | "failed" }
  | {
      type: "tool";
      id: string;
      name: string;
      summary: string;
      status: "running" | "waiting" | "done" | "failed" | "denied";
      args: unknown;
      result?: unknown;
      error?: unknown;
    }
  | { type: "approval"; approval: ApprovalView }
  | { type: "paused" }
  | { type: "message"; text: string }
  | {
      type: "finished";
      status: "completed" | "cancelled" | "failed";
      text: string;
    };

export interface TurnHandler {
  event(event: TurnEvent): Promise<void>;
}

// `args` describes what a command takes after its name, if anything.
export interface CommandInfo {
  name: string;
  description: string;
  args?: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "new", description: "Start a new conversation" },
  { name: "stop", description: "Stop the running turn" },
  { name: "status", description: "Show running turns and pending approvals" },
  {
    name: "model",
    description: "Show or change the model",
    args: "provider/model",
  },
  {
    name: "policy",
    description: "Show the rules, or ask Nu to change them",
    args: "request",
  },
  {
    name: "specialist",
    description: "List specialists, or switch this conversation to one",
    args: "name",
  },
  { name: "tools", description: "List package tools" },
  { name: "mcp", description: "Show each MCP server's tools" },
  { name: "secret", description: "Save a secret", args: "NAME value" },
  {
    name: "config",
    description: "Configure a package",
    args: "namespace key value",
  },
  { name: "reload", description: "Restart Nu's services" },
];

export interface MessageRef {
  channelId: string;
  messageId: string;
}

export interface ChannelAdapter {
  readonly name: string;
  readonly userId: string;
  readonly limits: { maxMessageLength: number; minEditIntervalMs: number };
  readonly supportsEdits: boolean;

  start(handlers: {
    commands: CommandInfo[];
    onMessage(message: InboundMessage): Promise<void>;
    onApprovalAction(action: ApprovalAction): Promise<string>;
    onCommand(command: Command): Promise<void>;
  }): Promise<void>;
  reply(target: ReplyTarget, text: string): Promise<MessageRef>;
  sendFiles?(
    target: ReplyTarget,
    files: { name: string; data: Buffer }[],
  ): Promise<void>;
  edit(ref: MessageRef, text: string): Promise<void>;
  postApproval(
    target: ReplyTarget,
    approval: ApprovalView,
  ): Promise<MessageRef>;
  typing?(target: ReplyTarget): Promise<void>;
  reachable?(): boolean;
  turn?(target: ReplyTarget): TurnHandler;
  createThread?(target: ReplyTarget, title: string): Promise<ReplyTarget>;
}
