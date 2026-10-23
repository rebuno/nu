import type { Extension } from "@rebuno/nu-types";
import { type Config, connect } from "./lib/mail.ts";

// `watch` lists senders, as addresses or @domains, or is `all`. Without it,
// new mail does not start turns.
const matches = (watch: string, sender: string) =>
  watch === "all" ||
  watch
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) =>
      entry.startsWith("@") ? sender.endsWith(entry) : sender === entry,
    );

const extension: Extension = (nu) => {
  const config = nu.config as Config;
  const pass = nu.secret("EMAIL_PASSWORD");
  const watch = config.watch?.trim().toLowerCase();
  if (!watch || !pass) return;
  nu.registerWatcher(async ({ report }) => {
    for (;;) {
      try {
        const client = await connect(config, pass);
        await client.mailboxOpen("INBOX");
        let next = client.mailbox ? Number(client.mailbox.uidNext) : 1;
        let checking = Promise.resolve();
        // IMAP returns the last message for `next:*` even when nothing is
        // newer, so the uid is checked again.
        const check = async () => {
          for await (const message of client.fetch(
            `${next}:*`,
            { envelope: true },
            { uid: true },
          )) {
            if (message.uid < next) continue;
            next = message.uid + 1;
            const sender = message.envelope?.from?.[0]?.address?.toLowerCase();
            if (!sender || !matches(watch, sender)) continue;
            await report({
              source: "email",
              key: message.envelope?.messageId ?? `${message.uid}`,
              text: `New email from ${sender}: "${message.envelope?.subject ?? ""}" (uid ${message.uid} in INBOX).`,
            });
          }
        };
        client.on("exists", () => {
          checking = checking.then(check).catch((error) => {
            console.error("email: checking new mail failed:", error.message);
          });
        });
        await new Promise((resolve) => client.once("close", resolve));
      } catch (error) {
        console.error(
          "email: watcher failed:",
          error instanceof Error ? error.message : error,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  });
};

export default extension;
