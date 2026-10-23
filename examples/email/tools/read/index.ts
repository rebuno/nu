import { simpleParser } from "mailparser";
import { type Config, withMailbox } from "../../lib/mail.ts";

const MAX_TEXT = 30_000;

export default async function read(
  args: { uid: number; folder?: string },
  { config }: { config: Config },
) {
  const m =
    (await withMailbox(config, args.folder ?? "inbox", (client) =>
      client.fetchOne(String(args.uid), { source: true }, { uid: true }),
    )) || undefined;
  if (!m?.source) throw new Error(`no message ${args.uid}`);
  const mail = await simpleParser(m.source);
  const list = (a: typeof mail.to) =>
    (Array.isArray(a) ? a : a ? [a] : []).map((x) => x.text).join(", ");
  return {
    from: mail.from?.text,
    to: list(mail.to),
    cc: list(mail.cc),
    date: mail.date,
    subject: mail.subject,
    text: (mail.text ?? "").slice(0, MAX_TEXT),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename,
      size: a.size,
    })),
  };
}
