import { type Config, withMailbox } from "../../lib/mail.ts";

export default async function search(
  args: {
    folder?: string;
    from?: string;
    subject?: string;
    text?: string;
    since?: string;
    unread?: boolean;
    limit?: number;
  },
  { config }: { config: Config },
) {
  return withMailbox(config, args.folder ?? "inbox", async (client) => {
    const query = Object.fromEntries(
      Object.entries({
        from: args.from,
        subject: args.subject,
        body: args.text,
        since: args.since && new Date(args.since),
        seen: args.unread ? false : undefined,
      }).filter(([, value]) => value !== undefined),
    );
    const uids = (await client.search(query, { uid: true })) || [];
    const latest = uids.slice(-(args.limit ?? 20));
    if (!latest.length) return [];
    const messages = [];
    for await (const m of client.fetch(
      latest,
      { envelope: true, flags: true },
      { uid: true },
    ))
      messages.push({
        uid: m.uid,
        date: m.envelope?.date,
        from: m.envelope?.from?.map((a) => a.address).join(", "),
        subject: m.envelope?.subject,
        unread: !m.flags?.has("\\Seen"),
      });
    return messages.reverse();
  });
}
