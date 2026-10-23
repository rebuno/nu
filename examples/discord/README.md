# nu-discord

A Discord channel for [Nu](https://github.com/rebuno/nu).

Create a bot in the [Discord developer portal](https://discord.com/developers/applications),
then install the package and configure it:

```bash
nu install ./examples/discord
nu config set discord userId <your Discord user ID>
printf %s '<bot token>' | nu secret set DISCORD_TOKEN
```

Nu reloads and logs the bot's invite link. Add the bot to a private server,
then message it directly or mention it in a channel. Approvals show as buttons,
attachments are saved to Nu's workspace, and Nu can send files back.
