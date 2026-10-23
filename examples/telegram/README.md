# nu-telegram

A Telegram channel for [Nu](https://github.com/rebuno/nu).

Create a bot by messaging [@BotFather](https://t.me/BotFather) with `/newbot`,
then install the package and give Nu the token:

```bash
nu install ./examples/telegram
printf %s '<bot token>' | nu secret set TELEGRAM_TOKEN
```

Nu reloads and logs the bot's link. Message the bot. Nu logs your user ID with
the command to set it:

```bash
nu config set telegram userId <your Telegram user ID>
```

Nu answers only that user. In a group, mention the bot or reply to it.
Approvals show as buttons, attachments are saved to Nu's workspace, and Nu can
send files back. Commands such as `/new`, `/stop`, and `/status` appear in
Telegram's command menu.
