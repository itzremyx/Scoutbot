# ScoutBot

Private Discord bot for Gentra's server. It is not packaged or configured as a multi-server bot: the owner, AI channel, changelog channels, auto-role and command defaults all belong to this one server.

It handles AI chat, support tickets, moderation, levels, logs, giveaways and backups for that server.

## Run it

```bash
npm install
cp .env.example .env
node index.js
```

Put the server's `DISCORD_TOKEN` and `AI_API_KEY` in `.env`. The file stays on the machine and is gitignored.

`GITHUB_TOKEN` is optional. `itzremyx/Scoutbot` is public, so commit announcements work without it. If a token is present but rejected, the bot retries the public GitHub API without it.

## This server

The default IDs in `src/config.js` are the live IDs for Gentra's server:

- AI channel: `1568689660245450993`
- ScoutCode updates: `1566490353748680814`
- ScoutCode changelog: `1566490537006202880`
- ScoutBot commits: `1568689855284777144`
- auto-role: `1566953972290289764`
- owner: Gentra (`1561860035158736898`)

ScoutBot commit posts need `View Channel`, `Send Messages` and `Embed Links` in the commit channel. The bot posts each new commit once. `/repo-refresh` forces a check, and `/changelog` shows recent commits on demand.

## Deploy

`push.cmd` commits local changes and pushes them to `https://github.com/itzremyx/Scoutbot.git`. The Enzonic host pulls that repository and restarts the bot. `data/`, `.env` and `node_modules/` are not part of the deployment, so the host keeps its own settings and database.

## Commands

- `/help` lists the commands
- `/setup` configures logs, tickets and levels
- `/memory` manages user facts, server rules and pending approvals
- `/doctor` checks channels, permissions, the AI endpoint and stored data (bot owner only)
- `/tag` stores reusable answers (`show`, `list`, `add`, `edit`, `remove`)
- `/suggest` opens a forum post with votes; staff use `/accept`, `/decline` or `/duplicate` inside it
- `/transcript search` looks through archived ticket transcripts
- `/translate` translates text into a chosen language
- Tickets idle for 48 hours close automatically, with the transcript sent to the log channel and the opener. A 1-5 star feedback form follows in DM and the rating is posted to the logs.
- Anti-nuke watches the audit log for destructive bursts and alerts the owner; alt detection only reports suspicious new accounts to the logs. Both take no punitive action on their own.
