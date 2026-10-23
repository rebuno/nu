import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

export type Config = {
  address?: string;
  imapHost?: string;
  smtpHost?: string;
  watch?: string;
};

const server = (value: string | undefined, key: string, port: number) => {
  if (!value) throw new Error(`set it with: nu config set email ${key} <host>`);
  const [host, p] = value.split(":");
  return { host, port: Number(p ?? port) };
};

const auth = (config: Config, pass = process.env.EMAIL_PASSWORD ?? "") => {
  if (!config.address)
    throw new Error("set it with: nu config set email address <address>");
  return { user: config.address, pass };
};

export async function connect(config: Config, pass?: string) {
  const client = new ImapFlow({
    ...server(config.imapHost, "imapHost", 993),
    secure: true,
    auth: auth(config, pass),
    logger: false,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}

export async function withMailbox<T>(
  config: Config,
  folder: string,
  run: (client: ImapFlow, path: string) => Promise<T>,
) {
  const client = await connect(config);
  try {
    const path = await resolveFolder(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      return await run(client, path);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// Folder names differ between providers, so "inbox", "drafts", "sent",
// "archive", "trash", and "junk" resolve through each folder's special use.
// Gmail has no archive folder; archiving there moves mail to All Mail.
export async function resolveFolder(client: ImapFlow, folder: string) {
  const folders = await client.list();
  const special = `\\${folder[0]?.toUpperCase()}${folder.slice(1).toLowerCase()}`;
  const found =
    folders.find((f) => f.path === folder) ??
    folders.find((f) => f.specialUse === special) ??
    (special === "\\Archive"
      ? folders.find((f) => f.specialUse === "\\All")
      : undefined) ??
    folders.find((f) => f.path.toLowerCase() === folder.toLowerCase());
  if (!found)
    throw new Error(
      `no folder ${folder}. Folders: ${folders.map((f) => f.path).join(", ")}`,
    );
  return found.path;
}

export type Compose = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  reply_to?: { uid: number; folder?: string };
};

export async function message(config: Config, args: Compose) {
  const mail = {
    from: auth(config).user,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    text: args.text,
    inReplyTo: undefined as string | undefined,
    references: undefined as string[] | undefined,
  };
  if (args.reply_to) {
    const { uid, folder = "inbox" } = args.reply_to;
    const original = await withMailbox(config, folder, (client) =>
      client.fetchOne(
        String(uid),
        { envelope: true, headers: ["references"] },
        { uid: true },
      ),
    );
    if (!original) throw new Error(`no message ${uid} in ${folder}`);
    const id = original.envelope?.messageId;
    const previous = original.headers
      ?.toString()
      .replace(/^references:\s*/i, "")
      .split(/\s+/)
      .filter(Boolean);
    mail.inReplyTo = id;
    mail.references = [...(previous ?? []), ...(id ? [id] : [])];
  }
  return mail;
}

export async function send(config: Config, args: Compose) {
  const smtp = server(config.smtpHost, "smtpHost", 465);
  const transport = createTransport({
    ...smtp,
    secure: smtp.port !== 587,
    requireTLS: true,
    auth: auth(config),
  });
  const info = await transport.sendMail(await message(config, args));
  return { messageId: info.messageId, accepted: info.accepted };
}

export async function draft(config: Config, args: Compose) {
  const raw = await new MailComposer(await message(config, args))
    .compile()
    .build();
  return withMailbox(config, "drafts", async (client, path) => {
    const result = await client.append(path, raw, ["\\Draft", "\\Seen"]);
    return { folder: path, uid: result ? result.uid : undefined };
  });
}
