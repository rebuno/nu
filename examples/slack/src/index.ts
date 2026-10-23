import type {
  ApprovalDecision,
  ApprovalView,
  ChannelAdapter,
  MessageRef,
  NuExtensionAPI,
  ReplyTarget,
} from "@rebuno/nu-types";

type Handlers = Parameters<ChannelAdapter["start"]>[0];
type SlackEvent = {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel: string;
  channel_type?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: { name?: string; url_private_download?: string }[];
};
type Envelope = {
  type: string;
  envelope_id?: string;
  payload?: Record<string, unknown>;
};

const markdown = (text: string) => [{ type: "markdown", text: text || " " }];

class SlackAdapter implements ChannelAdapter {
  readonly name = "slack";
  readonly limits = { maxMessageLength: 12_000, minEditIntervalMs: 1500 };
  readonly supportsEdits = true;
  #botId = "";
  // Threads Nu was mentioned in, where it answers without another mention.
  readonly #threads = new Set<string>();
  readonly #approvals = new Map<string, MessageRef & { title: string }>();

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    readonly userId: string,
  ) {}

  async #call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    token = this.botToken,
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined)
        body.set(
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        );
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.#call(method, params, token);
    }
    const data = (await response.json()) as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
    return data as T;
  }

  async start(handlers: Handlers) {
    const { user_id } = await this.#call<{ user_id: string }>("auth.test");
    this.#botId = user_id;
    await this.#connect(handlers);
  }

  async #connect(handlers: Handlers) {
    const { url } = await this.#call<{ url: string }>(
      "apps.connections.open",
      {},
      this.appToken,
    );
    const socket = new WebSocket(url);
    let reconnecting = false;
    const reconnect = () => {
      if (reconnecting) return;
      reconnecting = true;
      socket.close();
      setTimeout(
        () =>
          this.#connect(handlers).catch((error) => {
            console.error("slack: reconnect failed", error);
            reconnecting = false;
            reconnect();
          }),
        2000,
      );
    };
    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(String(event.data)) as Envelope;
      if (envelope.type === "disconnect") return reconnect();
      if (!envelope.envelope_id) return;
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      this.#envelope(envelope, handlers).catch((error) =>
        console.error("slack: event failed", error),
      );
    });
    socket.addEventListener("close", reconnect);
    socket.addEventListener("error", reconnect);
    await new Promise((resolve) =>
      socket.addEventListener("open", resolve, { once: true }),
    );
  }

  #isUser(id: unknown) {
    if (id === this.userId) return true;
    console.log(
      `slack: ignoring user ${id}. If that's you, run: nu config set slack userId ${id}`,
    );
    return false;
  }

  async #envelope({ type, payload = {} }: Envelope, handlers: Handlers) {
    if (type === "events_api")
      return this.#message(payload.event as SlackEvent, handlers);
    if (type === "slash_commands") return this.#command(payload, handlers);
    if (type === "interactive") return this.#interaction(payload, handlers);
  }

  async #message(event: SlackEvent, handlers: Handlers) {
    if (event.type !== "message" || event.bot_id || !event.user) return;
    if (event.subtype && event.subtype !== "file_share") return;
    const direct = event.channel_type === "im";
    const mention = `<@${this.#botId}>`;
    const text = event.text ?? "";
    const threadId = event.thread_ts ?? (direct ? undefined : event.ts);
    const addressed =
      direct ||
      text.includes(mention) ||
      (event.thread_ts && this.#threads.has(event.thread_ts));
    if (!addressed || !this.#isUser(event.user)) return;
    if (threadId && !direct) this.#threads.add(threadId);
    await handlers.onMessage({
      conversationId: event.channel,
      threadId,
      direct,
      senderId: event.user,
      messageId: `${event.channel}-${event.ts}`,
      text: text.replaceAll(mention, "").trim(),
      attachments: await this.#attachments(event.files ?? []),
    });
  }

  // Slack file URLs need the bot token, so files are passed as data URLs.
  async #attachments(files: NonNullable<SlackEvent["files"]>) {
    const attachments = [];
    for (const { name, url_private_download: url } of files) {
      if (!url) continue;
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.botToken}` },
      });
      const data = Buffer.from(await response.arrayBuffer());
      attachments.push({
        name: name ?? "file",
        url: `data:application/octet-stream;base64,${data.toString("base64")}`,
      });
    }
    return attachments;
  }

  async #command(payload: Record<string, unknown>, handlers: Handlers) {
    const [name = "", ...args] = String(payload.text ?? "")
      .trim()
      .split(/\s+/);
    const respond = (text: string) =>
      fetch(String(payload.response_url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          text,
          blocks: markdown(text.slice(0, 12_000)),
        }),
      }).then(() => {});
    if (!name)
      return respond(
        handlers.commands
          .map(
            ({ name, args, description }) =>
              `\`/nu ${name}${args ? ` ${args}` : ""}\` ${description}`,
          )
          .join("\n"),
      );
    if (!this.#isUser(payload.user_id)) return;
    const channel = String(payload.channel_id);
    await handlers.onCommand({
      conversationId: channel,
      direct: channel.startsWith("D"),
      senderId: String(payload.user_id),
      name,
      args: args.join(" "),
      respond,
    });
  }

  async #interaction(payload: Record<string, unknown>, handlers: Handlers) {
    const user = (payload.user as { id: string }).id;
    if (payload.type === "block_actions") {
      const [action] = payload.actions as { action_id: string }[];
      const [decision, approvalId] = action.action_id.split(":");
      const channel = (payload.channel as { id: string }).id;
      const { ts, thread_ts } = payload.message as {
        ts: string;
        thread_ts?: string;
      };
      if (decision === "rule") {
        await this.#call("views.open", {
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            callback_id: `rule:${approvalId}`,
            private_metadata: JSON.stringify({ channel, thread_ts }),
            title: { type: "plain_text", text: "Write a rule" },
            submit: { type: "plain_text", text: "Save" },
            blocks: [
              {
                type: "input",
                block_id: "rule",
                label: {
                  type: "plain_text",
                  text: "What should happen with calls like this?",
                },
                element: {
                  type: "plain_text_input",
                  action_id: "text",
                  multiline: true,
                  max_length: 1000,
                },
              },
            ],
          },
        });
        return;
      }
      const result = await handlers.onApprovalAction({
        senderId: user,
        approvalId,
        decision: decision as ApprovalDecision,
      });
      if (user !== this.userId) return;
      const title = this.#approvals.get(approvalId)?.title ?? "Tool call";
      await this.edit(
        { channelId: channel, messageId: ts },
        `${title} · ${result}`,
      );
      return;
    }
    if (payload.type === "view_submission") {
      const view = payload.view as {
        callback_id: string;
        private_metadata: string;
        state: { values: { rule: { text: { value: string } } } };
      };
      const [, approvalId] = view.callback_id.split(":");
      const { channel, thread_ts } = JSON.parse(view.private_metadata);
      const result = await handlers.onApprovalAction({
        senderId: user,
        approvalId,
        decision: "rule",
        text: view.state.values.rule.text.value,
      });
      await this.#call("chat.postEphemeral", {
        channel,
        user,
        thread_ts,
        text: result,
      });
    }
  }

  async reply(target: ReplyTarget, text: string): Promise<MessageRef> {
    const { ts } = await this.#call<{ ts: string }>("chat.postMessage", {
      channel: target.conversationId,
      thread_ts: target.threadId,
      text,
      blocks: markdown(text),
      unfurl_links: false,
    });
    return { channelId: target.conversationId, messageId: ts };
  }

  async edit(ref: MessageRef, text: string) {
    await this.#call("chat.update", {
      channel: ref.channelId,
      ts: ref.messageId,
      text,
      blocks: markdown(text),
    });
  }

  async sendFiles(
    target: ReplyTarget,
    files: { name: string; data: Buffer }[],
  ) {
    const uploaded = [];
    for (const { name, data } of files) {
      const { upload_url, file_id } = await this.#call<{
        upload_url: string;
        file_id: string;
      }>("files.getUploadURLExternal", {
        filename: name,
        length: String(data.length),
      });
      await fetch(upload_url, {
        method: "POST",
        body: new Uint8Array(data),
      });
      uploaded.push({ id: file_id, title: name });
    }
    await this.#call("files.completeUploadExternal", {
      files: uploaded,
      channel_id: target.conversationId,
      thread_ts: target.threadId,
    });
  }

  async createThread(target: ReplyTarget, title: string) {
    if (target.direct) return target;
    const { ts } = await this.#call<{ ts: string }>("chat.postMessage", {
      channel: target.conversationId,
      text: title,
    });
    this.#threads.add(ts);
    return {
      conversationId: target.conversationId,
      threadId: ts,
      direct: false,
    };
  }

  async postApproval(
    target: ReplyTarget,
    approval: ApprovalView,
  ): Promise<MessageRef> {
    const posted = this.#approvals.get(approval.id);
    if (!approval.choices.length) {
      this.#approvals.delete(approval.id);
      const text = `\`${approval.target}\` · ${approval.status ?? "Decided."}`;
      if (posted) {
        await this.edit(posted, text);
        return posted;
      }
      return this.reply(target, text);
    }
    const text = [
      "*Approval needed*",
      approval.summary,
      approval.reason,
      approval.status,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 3000);
    const blocks = [
      ...markdown(text),
      {
        type: "actions",
        elements: approval.choices.map((choice) => ({
          type: "button",
          action_id: `${choice.decision}:${approval.id}`,
          text: { type: "plain_text", text: choice.label.slice(0, 75) },
          style:
            choice.decision === "once"
              ? "primary"
              : choice.decision === "deny"
                ? "danger"
                : undefined,
        })),
      },
    ];
    if (posted) {
      await this.#call("chat.update", {
        channel: posted.channelId,
        ts: posted.messageId,
        text,
        blocks,
      });
      return posted;
    }
    const { ts } = await this.#call<{ ts: string }>("chat.postMessage", {
      channel: target.conversationId,
      thread_ts: target.threadId,
      text,
      blocks,
    });
    const ref = { channelId: target.conversationId, messageId: ts };
    this.#approvals.set(approval.id, {
      ...ref,
      title: approval.summary.split("\n")[0] ?? "",
    });
    return ref;
  }
}

export default function slack(nu: NuExtensionAPI) {
  const botToken = nu.secret("SLACK_BOT_TOKEN");
  const appToken = nu.secret("SLACK_APP_TOKEN");
  if (!botToken || !appToken)
    throw new Error("set the SLACK_BOT_TOKEN and SLACK_APP_TOKEN secrets");
  nu.registerChannel(
    new SlackAdapter(botToken, appToken, String(nu.config.userId ?? "")),
  );
}
