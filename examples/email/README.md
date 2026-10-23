# nu-email

Email for [Nu](https://github.com/rebuno/nu) over IMAP and SMTP. Nu can search
and read your mail, save drafts, send, and move messages between folders.

Create an app password with your provider, then install and configure the
package:

```bash
nu install ./examples/email
nu config set email address you@example.com
nu config set email imapHost imap.example.com
nu config set email smtpHost smtp.example.com
printf %s '<app password>' | nu secret set EMAIL_PASSWORD
```

| Provider | imapHost | smtpHost |
|---|---|---|
| Gmail | `imap.gmail.com` | `smtp.gmail.com` |
| Outlook | `outlook.office365.com` | `smtp.office365.com:587` |
| iCloud | `imap.mail.me.com` | `smtp.mail.me.com:587` |
| Fastmail | `imap.fastmail.com` | `smtp.fastmail.com` |

IMAP uses TLS on port 993. SMTP uses TLS on port 465, or STARTTLS on 587.
Add `:<port>` to a host to change it.

| Tool | Does |
|---|---|
| `email__search` | Lists messages in a folder, newest first |
| `email__read` | Reads a message without marking it read |
| `email__draft` | Saves a message to your drafts folder |
| `email__send` | Sends a message |
| `email__move` | Moves messages to another folder |

The suggested rules let Nu search, read, and draft without asking. Sending and
moving ask first.

## New mail

To have Nu look at new mail as it arrives, list the senders to watch, as
addresses or `@domains`, or `all`:

```bash
nu config set email watch "@example.com, boss@example.org"
```

Each matching email starts a turn in your main conversation, and Nu decides
whether you need to know. The watcher runs inside Nu as an extension, with Nu's
own access.

## Folders

Folders can be named `inbox`, `drafts`, `sent`, `archive`, `trash`, or `junk`
on any provider.
