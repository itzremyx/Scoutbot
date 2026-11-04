# ScoutBot

Discord bot with AI chat, support tickets, moderation, levels, logs, giveaways and backups.

## Setup

```bash
npm install
cp .env.example .env   # then fill in DISCORD_TOKEN and the AI_* keys
node index.js
```

Only `DISCORD_TOKEN`, `GITHUB_TOKEN` (needed because the ScoutBot repository is private) and
`AI_*` settings belong in `.env`; it is gitignored and never uploaded. `GITHUB_TOKEN` needs
read access to `itzremyx/Scoutbot`.

The bot can read image attachments in normal chat and with `/ask image`. `/imagine` uses
ScoutCode's `openai-gpt-5-image` through `https://scoutcode.dev/v1/images/generations` and
reuses `AI_API_KEY` by default. `AI_IMAGE_BASE_URL`, `AI_IMAGE_ENDPOINT` and `AI_IMAGE_API_KEY`
can override those defaults for another compatible provider.

The bot watches `itzremyx/Scoutbot` on `master` and posts the current commit once on first
sync, then every new commit, to `BOT_REPO_CHANNEL_ID`. Use `/repo-refresh` as the owner to
trigger an immediate check. The bot needs `View Channel`, `Send Messages` and `Embed Links`
permissions in that Discord channel.

## Sending changes to GitHub

Run `push.cmd` (double-click, or from a terminal with an optional message):

```bat
push.cmd "Fix rank card colors"
```

It stages everything, commits if something changed and pushes. On the very first run it also
creates the GitHub repository and links it as `origin`.

The host can then pull from `https://github.com/itzremyx/Scoutbot.git`. `data/`, `.env` and
`node_modules/` are gitignored, so pulls never overwrite the host's own settings or database.

## Useful commands

- `/help` — list all commands
- `/setup` — first-run configuration (logs channel, tickets, levels)
- `/memory` — user facts, server rules, pending approvals
