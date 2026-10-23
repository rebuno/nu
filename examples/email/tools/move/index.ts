import { type Config, resolveFolder, withMailbox } from "../../lib/mail.ts";

export default async function move(
  args: { uids: number[]; folder?: string; to: string },
  { config }: { config: Config },
) {
  return withMailbox(config, args.folder ?? "inbox", async (client) => {
    const to = await resolveFolder(client, args.to);
    await client.messageMove(args.uids.map(String).join(","), to, {
      uid: true,
    });
    return { moved: args.uids.length, to };
  });
}
