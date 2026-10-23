import type {
  ApprovalDecision,
  ApprovalView,
  ChannelAdapter,
  MessageRef,
  NuExtensionAPI,
  ReplyTarget,
} from "@rebuno/nu-types";

type User = { id: number; username?: string };
type Chat = { id: number; type: string };
type TelegramMessage = {
  message_id: number;
  from?: User;
  chat: Chat;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: { message_id: number; from?: User };
  document?: { file_id: string; file_name?: string };
  photo?: { file_id: string }[];
  voice?: { file_id: string };
  audio?: { file_id: string; file_name?: string };
  video?: { file_id: string; file_name?: string };
};
type Update = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: User;
    data?: string;
    message?: TelegramMessage;
  };
};

class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  readonly limits = { maxMessageLength: 4096, minEditIntervalMs: 1500 };
  readonly supportsEdits = true;
  #me?: User;
  readonly #approvals = new Map<string, MessageRef & { title: string }>();
  // Prompts sent for "Write a rule", by message id, waiting for a reply.
  readonly #rulePrompts = new Map<number, string>();

  constructor(
    private readonly token: string,
    readonly userId: string,
  ) {}

  async #call<T>(method: string, body: object | FormData = {}): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      body instanceof FormData
        ? { method: "POST", body }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = (await response.json()) as {
      ok: boolean;
      result: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    const wait = data.parameters?.retry_after;
    if (wait) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.#call(method, body);
    }
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  async start(handlers: Parameters<ChannelAdapter["start"]>[0]) {
    this.#me = await this.#call<User>("getMe");
    await this.#call("setMyCommands", {
      commands: handlers.commands
        .filter(({ name }) => /^[a-z0-9_]{1,32}$/.test(name))
        .map(({ name, args, description }) => ({
          command: name,
          description: args ? `${description}: /${name} ${args}` : description,
        })),
    });
    console.log(
      `telegram: message the bot at https://t.me/${this.#me.username}`,
    );
    void this.#poll(handlers);
  }

  async #poll(handlers: Parameters<ChannelAdapter["start"]>[0]) {
    let offset = 0;
    for (;;) {
      try {
        const updates = await this.#call<Update[]>("getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          this.#update(update, handlers).catch((error) =>
            console.error("telegram: update failed", error),
          );
        }
      } catch (error) {
        console.error("telegram: polling failed", error);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async #update(
    update: Update,
    handlers: Parameters<ChannelAdapter["start"]>[0],
  ) {
    const query = update.callback_query;
    if (query?.data && query.message) {
      const [action, approvalId] = query.data.split(":");
      if (action === "rule") {
        await this.#call("answerCallbackQuery", {
          callback_query_id: query.id,
        });
        const prompt = await this.#call<TelegramMessage>("sendMessage", {
          chat_id: query.message.chat.id,
          message_thread_id: query.message.message_thread_id,
          text: "What should happen with calls like this? Reply to this message.",
          reply_markup: { force_reply: true, selective: true },
        });
        this.#rulePrompts.set(prompt.message_id, approvalId);
        return;
      }
      const result = await handlers.onApprovalAction({
        senderId: String(query.from.id),
        approvalId,
        decision: action as ApprovalDecision,
      });
      await this.#call("answerCallbackQuery", {
        callback_query_id: query.id,
        text: result,
      });
      if (String(query.from.id) !== this.userId) return;
      const title = this.#approvals.get(approvalId)?.title ?? "Tool call";
      await this.edit(
        {
          channelId: String(query.message.chat.id),
          messageId: String(query.message.message_id),
        },
        `${title} · ${result}`,
      );
      return;
    }
    const message = update.message;
    if (!message?.from || message.from.id === this.#me?.id) return;
    const senderId = String(message.from.id);
    if (senderId !== this.userId) {
      console.log(
        `telegram: ignoring user ${senderId}. If that's you, run: nu config set telegram userId ${senderId}`,
      );
      return;
    }
    const location = {
      conversationId: String(message.chat.id),
      threadId: message.message_thread_id
        ? String(message.message_thread_id)
        : undefined,
      direct: message.chat.type === "private",
    };
    const text = (message.text ?? message.caption ?? "").trim();

    const prompt = message.reply_to_message?.message_id ?? 0;
    const ruleFor = this.#rulePrompts.get(prompt);
    if (ruleFor) {
      this.#rulePrompts.delete(prompt);
      await this.reply(
        location,
        await handlers.onApprovalAction({
          senderId,
          approvalId: ruleFor,
          decision: "rule",
          text,
        }),
      );
      return;
    }

    const mention = `@${this.#me?.username}`;
    const command = /^\/(\w+)(?:@(\w+))?\s*([\s\S]*)$/.exec(text);
    if (command && (!command[2] || `@${command[2]}` === mention)) {
      await handlers.onCommand({
        ...location,
        senderId,
        name: command[1],
        args: command[3].trim(),
        respond: async (reply) => {
          await this.reply(location, reply);
        },
      });
      return;
    }

    const addressed =
      location.direct ||
      text.includes(mention) ||
      message.reply_to_message?.from?.id === this.#me?.id;
    if (!addressed) return;
    await handlers.onMessage({
      ...location,
      senderId,
      messageId: `${message.chat.id}-${message.message_id}`,
      text: text.replaceAll(mention, "").trim(),
      attachments: await this.#attachments(message),
    });
  }

  // Telegram file URLs contain the bot token, so files are passed as data URLs.
  async #attachments(message: TelegramMessage) {
    const files = [
      message.document && {
        id: message.document.file_id,
        name: message.document.file_name,
      },
      message.photo?.length && {
        id: message.photo[message.photo.length - 1].file_id,
        name: "photo.jpg",
      },
      message.voice && { id: message.voice.file_id, name: "voice.ogg" },
      message.audio && {
        id: message.audio.file_id,
        name: message.audio.file_name,
      },
      message.video && {
        id: message.video.file_id,
        name: message.video.file_name,
      },
    ].filter((file) => !!file);
    const attachments = [];
    for (const { id, name } of files) {
      const { file_path } = await this.#call<{ file_path?: string }>(
        "getFile",
        { file_id: id },
      );
      if (!file_path) continue;
      const response = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${file_path}`,
      );
      const data = Buffer.from(await response.arrayBuffer());
      attachments.push({
        name: name ?? file_path.split("/").pop() ?? "file",
        url: `data:application/octet-stream;base64,${data.toString("base64")}`,
      });
    }
    return attachments;
  }

  #target(target: ReplyTarget) {
    return {
      chat_id: target.conversationId,
      message_thread_id: target.threadId ? Number(target.threadId) : undefined,
    };
  }

  async reply(target: ReplyTarget, text: string): Promise<MessageRef> {
    const message = await this.#call<TelegramMessage>("sendMessage", {
      ...this.#target(target),
      text,
      link_preview_options: { is_disabled: true },
    });
    return {
      channelId: target.conversationId,
      messageId: String(message.message_id),
    };
  }

  async edit(ref: MessageRef, text: string) {
    await this.#call("editMessageText", {
      chat_id: ref.channelId,
      message_id: Number(ref.messageId),
      text,
      link_preview_options: { is_disabled: true },
    }).catch((error) => {
      if (!String(error).includes("message is not modified")) throw error;
    });
  }

  async sendFiles(
    target: ReplyTarget,
    files: { name: string; data: Buffer }[],
  ) {
    for (const { name, data } of files) {
      const form = new FormData();
      for (const [key, value] of Object.entries(this.#target(target)))
        if (value !== undefined) form.append(key, String(value));
      form.append("document", new Blob([new Uint8Array(data)]), name);
      await this.#call("sendDocument", form);
    }
  }

  async typing(target: ReplyTarget) {
    await this.#call("sendChatAction", {
      ...this.#target(target),
      action: "typing",
    });
  }

  async postApproval(
    target: ReplyTarget,
    approval: ApprovalView,
  ): Promise<MessageRef> {
    const posted = this.#approvals.get(approval.id);
    const decided = !approval.choices.length;
    const text = decided
      ? `${approval.target} · ${approval.status ?? "Decided."}`
      : ["Approval needed", approval.summary, approval.reason, approval.status]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 4096);
    const reply_markup = {
      inline_keyboard: approval.choices.map((choice) => [
        {
          text: choice.label,
          callback_data: `${choice.decision}:${approval.id}`,
        },
      ]),
    };
    if (decided) this.#approvals.delete(approval.id);
    if (posted) {
      await this.#call("editMessageText", {
        chat_id: posted.channelId,
        message_id: Number(posted.messageId),
        text,
        reply_markup,
      }).catch(() => {});
      return posted;
    }
    const message = await this.#call<TelegramMessage>("sendMessage", {
      ...this.#target(target),
      text,
      reply_markup,
    });
    const ref = {
      channelId: target.conversationId,
      messageId: String(message.message_id),
    };
    if (!decided)
      this.#approvals.set(approval.id, {
        ...ref,
        title: approval.summary.split("\n")[0] ?? "",
      });
    return ref;
  }
}

export default function telegram(nu: NuExtensionAPI) {
  const token = nu.secret("TELEGRAM_TOKEN");
  if (!token) throw new Error("set the TELEGRAM_TOKEN secret");
  nu.registerChannel(
    new TelegramAdapter(token, String(nu.config.userId ?? "")),
  );
}
