# nu-slack

A Slack channel for [Nu](https://github.com/rebuno/nu). It connects over Socket
Mode, so Nu needs no public URL.

1. [Create a Slack app](https://api.slack.com/apps?new_app=1) from a manifest
   and paste [`manifest.yaml`](manifest.yaml).
2. Under **Basic Information**, create an app-level token with the
   `connections:write` scope.
3. Install the app to your workspace and copy the bot token from **OAuth &
   Permissions**.

```bash
nu install ./examples/slack
printf %s '<xoxb- bot token>' | nu secret set SLACK_BOT_TOKEN
printf %s '<xapp- app token>' | nu secret set SLACK_APP_TOKEN
```

Message the app directly. Nu logs your member ID with the command to set it:

```bash
nu config set slack userId <your Slack member ID>
```

Nu answers only that user. In a channel, invite the app and mention it. Nu
replies in a thread and keeps answering there without another mention.
Approvals show as buttons, attachments are saved to Nu's workspace, and Nu can
send files back. Commands run through `/nu`, such as `/nu status` or
`/nu new`, and `/nu` on its own lists them.
