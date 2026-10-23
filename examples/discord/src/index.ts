import type {
  ApprovalDecision,
  ApprovalView,
  ChannelAdapter,
  CommandInfo,
  ListView,
  Location,
  MessageRef,
  NuExtensionAPI,
  ReplyTarget,
} from "@rebuno/nu-types";
import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ChannelType,
  ComponentType,
  Client as DiscordClient,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  MessageFlags,
  Partials,
  type SendableChannels,
  TextInputStyle,
} from "discord.js";

const PERMISSIONS = 1024n + 2048n + 65536n + 34359738368n + 274877906944n;

const command = ({ name, description, args }: CommandInfo) => ({
  name,
  description,
  options: args
    ? [
        {
          name: "args",
          description: args,
          type: ApplicationCommandOptionType.String as const,
        },
      ]
    : [],
});

function escapeUnderscores(text: string) {
  const escaped = text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 ? part : part.replace(/(?<=\w)__(?=\w)/g, "\\_\\_"),
    )
    .join("");
  return escaped.length > 2000 ? text : escaped;
}

function listEmbed(view: ListView) {
  const lines = view.items.map((item) =>
    escapeUnderscores(`**${item.name}** ${item.text}`),
  );
  let description = "";
  for (const line of lines) {
    if (description.length + line.length + 3 > 4096) {
      description += "\n…";
      break;
    }
    description += `${description ? "\n" : ""}${line}`;
  }
  return {
    title: view.title,
    description,
    footer: view.footer ? { text: view.footer } : undefined,
  };
}

class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  readonly limits = { maxMessageLength: 2000, minEditIntervalMs: 1000 };
  readonly supportsEdits = true;
  readonly #client = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  readonly #approvals = new Map<string, Message>();

  constructor(
    private readonly token: string,
    readonly userId: string,
  ) {}

  async start(handlers: Parameters<ChannelAdapter["start"]>[0]) {
    const client = this.#client;
    client.once(Events.ClientReady, async (ready) => {
      await ready.application.commands.set(handlers.commands.map(command));
      console.log(
        `discord: invite with https://discord.com/oauth2/authorize?client_id=${ready.application.id}&scope=bot+applications.commands&permissions=${PERMISSIONS}`,
      );
    });
    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot || !client.user) return;
      const direct = message.channel.type === ChannelType.DM;
      const ownThread =
        message.channel.isThread() &&
        message.channel.ownerId === client.user.id;
      if (!direct && !ownThread && !message.mentions.has(client.user)) return;
      handlers
        .onMessage({
          ...location(message),
          senderId: message.author.id,
          messageId: message.id,
          text: message.content.replace(/<@!?\d+>/g, "").trim(),
          attachments: message.attachments.map((file) => ({
            name: file.name,
            url: file.url,
          })),
        })
        .catch((error) => console.error("discord: message failed", error));
    });
    client.on(Events.InteractionCreate, (interaction) =>
      this.#interaction(interaction, handlers).catch((error) =>
        console.error("discord: interaction failed", error),
      ),
    );
    await client.login(this.token);
  }

  async #interaction(
    interaction: Interaction,
    handlers: Parameters<ChannelAdapter["start"]>[0],
  ) {
    if (interaction.isButton()) {
      const [action, approvalId] = interaction.customId.split(":");
      if (action === "rule") {
        await interaction.showModal({
          customId: `rule:${approvalId}`,
          title: "Write a rule",
          components: [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.TextInput,
                  customId: "text",
                  label: "What should happen with calls like this?",
                  style: TextInputStyle.Paragraph,
                  required: true,
                  maxLength: 1000,
                },
              ],
            },
          ],
        });
        return;
      }
      await interaction.deferUpdate();
      const result = await handlers.onApprovalAction({
        senderId: interaction.user.id,
        approvalId,
        decision: action as ApprovalDecision,
      });
      const title = interaction.message.embeds[0]?.title ?? "Tool call";
      await interaction.editReply({
        content: `-# ${title} · ${result}`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (interaction.isModalSubmit()) {
      const [, approvalId] = interaction.customId.split(":");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(
        await handlers.onApprovalAction({
          senderId: interaction.user.id,
          approvalId,
          decision: "rule",
          text: interaction.fields.getTextInputValue("text"),
        }),
      );
      return;
    }
    if (!interaction.isChatInputCommand() || !interaction.channel) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.channel;
    await handlers.onCommand({
      conversationId: channel.isThread()
        ? (channel.parentId ?? channel.id)
        : channel.id,
      threadId: channel.isThread() ? channel.id : undefined,
      direct: channel.type === ChannelType.DM,
      senderId: interaction.user.id,
      name: interaction.commandName,
      args: interaction.options.data.map((o) => String(o.value)).join(" "),
      respond: async (text, view) => {
        await interaction.editReply(
          view ? { embeds: [listEmbed(view)] } : escapeUnderscores(text),
        );
      },
    });
  }

  async #channel(id: string) {
    const channel = await this.#client.channels.fetch(id);
    if (!channel?.isSendable()) throw new Error(`cannot send to ${id}`);
    return channel as SendableChannels;
  }

  async createThread(target: ReplyTarget, title: string) {
    const channel = await this.#client.channels.fetch(target.conversationId);
    if (channel?.type !== ChannelType.GuildText) return target;
    const name = title.slice(0, 100);
    const thread =
      target.messageId && !target.threadId
        ? await (await channel.messages.fetch(target.messageId)).startThread({
            name,
          })
        : await channel.threads.create({ name });
    return {
      conversationId: channel.id,
      threadId: thread.id,
      direct: false,
    };
  }

  async reply(target: ReplyTarget, text: string): Promise<MessageRef> {
    const channelId = target.threadId ?? target.conversationId;
    const message = await (await this.#channel(channelId)).send(
      escapeUnderscores(text),
    );
    return { channelId, messageId: message.id };
  }

  async sendFiles(
    target: ReplyTarget,
    files: { name: string; data: Buffer }[],
  ) {
    const channel = await this.#channel(
      target.threadId ?? target.conversationId,
    );
    for (let i = 0; i < files.length; i += 10)
      await channel.send({
        files: files
          .slice(i, i + 10)
          .map(({ name, data }) => ({ attachment: data, name })),
      });
  }

  async edit(ref: MessageRef, text: string) {
    const channel = await this.#channel(ref.channelId);
    await (await channel.messages.fetch(ref.messageId)).edit(
      escapeUnderscores(text),
    );
  }

  async typing(target: ReplyTarget) {
    await (
      await this.#channel(target.threadId ?? target.conversationId)
    ).sendTyping();
  }

  async postApproval(
    target: ReplyTarget,
    approval: ApprovalView,
  ): Promise<MessageRef> {
    const channelId = target.threadId ?? target.conversationId;
    const [title = "", ...details] = approval.summary.split("\n");
    const posted = this.#approvals.get(approval.id);
    if (!approval.choices.length) {
      this.#approvals.delete(approval.id);
      const content = `-# \`${approval.target}\` · ${approval.status ?? "Decided."}`;
      if (posted) await posted.edit({ content, embeds: [], components: [] });
      const message =
        posted ?? (await (await this.#channel(channelId)).send(content));
      return { channelId, messageId: message.id };
    }
    const card = {
      embeds: [
        {
          author: { name: "Approval needed" },
          title: escapeUnderscores(title.slice(0, 256)),
          description:
            escapeUnderscores(details.join("\n").slice(0, 4096)) || undefined,
          footer:
            approval.reason || approval.status
              ? {
                  text: [approval.reason, approval.status]
                    .filter(Boolean)
                    .join("\n")
                    .slice(0, 2048),
                }
              : undefined,
          color: 0xfee75c,
        },
      ],
      components: [
        {
          type: ComponentType.ActionRow,
          components: approval.choices.map((choice) => ({
            type: ComponentType.Button as const,
            style:
              choice.decision === "once"
                ? ButtonStyle.Success
                : choice.decision === "deny"
                  ? ButtonStyle.Danger
                  : ButtonStyle.Primary,
            label: choice.label.slice(0, 80),
            customId: `${choice.decision}:${approval.id}`,
          })),
        },
      ],
    };
    if (posted) await posted.edit(card);
    const message =
      posted ?? (await (await this.#channel(channelId)).send(card));
    this.#approvals.set(approval.id, message);
    return { channelId, messageId: message.id };
  }
}

function location(message: Message): Location {
  const { channel } = message;
  return {
    conversationId: channel.isThread()
      ? (channel.parentId ?? channel.id)
      : channel.id,
    threadId: channel.isThread() ? channel.id : undefined,
    direct: channel.type === ChannelType.DM,
  };
}

export default function discord(nu: NuExtensionAPI) {
  const token = nu.secret("DISCORD_TOKEN");
  const { userId } = nu.config;
  if (!token || typeof userId !== "string")
    throw new Error(
      "set the DISCORD_TOKEN secret and the userId config of discord",
    );
  nu.registerChannel(new DiscordAdapter(token, userId));
}
