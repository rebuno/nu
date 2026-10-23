<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/nu-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/nu-mark-light.svg">
    <img src="assets/nu-mark-light.svg" alt="Nu" width="96">
  </picture>
</p>

# Nu

A self-hosted personal agent built on [Rebuno](https://github.com/rebuno/rebuno).

- **Governed:** every tool call is checked against your policy, and anything the
  policy does not allow waits for your approval.
- **Durable:** every step is recorded, so a turn interrupted by a crash or
  restart resumes where it stopped instead of repeating its effects.
- **Isolated:** shell commands and file edits run in a sandbox container that
  holds none of Nu's secrets.
- **Extensible:** packages can add to or change almost anything Nu does.

## Install

Nu needs Docker with Compose and Node.js 24 or later:

```bash
curl -fsSL https://nu.rebuno.io/install.sh | sh
nu login
nu
```

The installer starts the server from `~/.nu/compose.yaml` and installs the `nu`
terminal client. `nu login` lists model providers; `nu login <provider>` signs
in.

## Examples

[`examples/`](examples) holds example packages. Install one from a checkout with
`nu install ./examples/<name>`.

| Package | Adds |
|---------|------|
| [`firecrawl`](examples/firecrawl), [`tavily`](examples/tavily), [`exa`](examples/exa) | Web search and page reading |
| [`email`](examples/email) | Email over IMAP and SMTP |
| [`weather`](examples/weather) | Weather forecasts |
| [`discord`](examples/discord), [`telegram`](examples/telegram), [`slack`](examples/slack) | Chat channels |

## Documentation

See the [Nu documentation](https://docs.rebuno.io/nu/overview) for chat,
policy, tools, the sandbox, channels, extensions, and deployment.

## Development

```bash
pnpm install
make dev       # build and run the server from the checkout
pnpm nu        # open the terminal client
make client    # install the checkout's client as nu
make format    # format and fix lint
make typecheck
```
