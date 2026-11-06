// What the bot knows about ScoutCode, the platform it supports. Keep this factual: the bot repeats it
// to users, so anything unverified here becomes a wrong answer. Source: the project README on GitHub
// (github.com/gentraxyz/scoutcode) and scoutcode.dev. Update it when the site or app changes.
const SCOUTCODE = [
  'ScoutCode is a platform for AI coding. Its site is https://scoutcode.dev and its code is public at https://github.com/gentraxyz/scoutcode (MIT license, by Gentra).',
  'Scout is ScoutCode\'s desktop app. It reads code, edits files, runs commands and searches the web, with a diff and a permission card for every change. Download it from https://scoutcode.dev/download/windows (ARM64: https://scoutcode.dev/download/windows?arch=arm64).',
  'Scout requires Windows 10 or 11 (x64 or ARM64) with the WebView2 runtime. Scout offers the WebView2 download if it is missing.',
  'Install: run ScoutSetup.exe. It installs to %LOCALAPPDATA%\\Programs\\Scout, adds a Start menu entry and appears under Settings > Apps, where it can be uninstalled. The exe is not code-signed yet, so Windows SmartScreen warns the first time: choose More info, then Run anyway.',
  'Sign in with a browser, paste a ScoutCode API key, or choose Continue without an account (free models at the guest limits).',
  'Permission modes: Ask first, Accept edits, Plan (read-only), Auto (runs edits and commands but holds dangerous ones and edits outside the project for review) and Yolo (never asks). Shift+Tab cycles them.',
  'Undo: /undo puts the files back. Editing an earlier message also rewinds the files.',
  'Message commands: /compact [focus], /undo, /prune, /new. Enter sends; while Scout works, Enter queues the message. Ctrl+Enter steers the running turn, Esc stops it.',
  'Keyboard: Shift+Enter new line, Ctrl+N new chat, Ctrl+F find in the chat, Ctrl+` toggles the terminal, Ctrl+Shift+Space starts or stops dictation, Ctrl+S saves in the editor.',
  'Models and providers: ScoutCode\'s own models, plus your accounts with GitHub Copilot, OpenRouter, NVIDIA NIM, Kilo and others. Provider keys can also be set as environment variables (OPENROUTER_API_KEY, NVIDIA_API_KEY, KILO_API_KEY).',
  'Project memory is in .scout/memory.md (can be committed). Personal memory and instructions are in ~/.scoutcode. Project instructions can come from SCOUT.md, AGENTS.md or CLAUDE.md.',
  'Your data stays in ~/.scoutcode (config.json, sessions/, memory.md, instructions.json, skills/, mcp.json). Uninstalling keeps that folder; delete it to remove your chats and sign-in. Messages and attached files go to the model provider you pick.',
  'Updates: signed updates download in the background and install on restart. SCOUT_NO_UPDATE=1 turns them off. Release notes are in the CHANGELOG on GitHub.',
  'Environment variables: SCOUTCODE_API_KEY and SCOUTCODE_BASE_URL (use another key or server), SCOUT_HOME (data folder), SCOUT_TERMINAL (terminal shell), SCOUT_NO_UPDATE, SCOUT_UPDATE_URL.',
  'For billing, accounts or bugs you cannot solve: point the user to https://scoutcode.dev and to the support channels on this Discord. Never invent prices, limits or release dates.',
  'Enzonic (https://enzonic.com) is a game-server host with 24/7 servers, pay-per-minute Flex servers, free Minecraft servers, modpacks, subdomains, databases, backups, a web panel and a REST API.',
  'Enzonic Deploy (https://deploy.enzonic.com) connects GitHub, GitLab or Gitea repositories and deploys websites or bots with builds, environment variables, logs and automatic redeploys.',
  'Enzonic Domains (https://domains.enzonic.com) registers and manages domains, DNS records, WHOIS privacy and redirects.',
  'Enzonic CI (https://ci.enzonic.com) provides Git-triggered CI/CD builds and deployments for repositories.',
  'Enzonic Relay (https://relay.enzonic.com) provides outbound email relays for applications and bots.',
  'Enzonic Launcher (https://launcher.enzonic.com) is a custom Minecraft launcher service with themes, Java builds and automatic updates.',
  'SimpMuse (https://simpmuse.enzonic.com) is an AI companion and roleplay site.',
  'MineMate (https://minemate.enzonic.com) is an AI assistant for Minecraft players.',
  'Modpacks.net (https://modpacks.net) is a Minecraft modpack site.',
  'Aevon (https://aevon.ink) is a link-in-bio and creator-page service.',
  'RapidFile (https://rapidfile.cc) is a file-sharing service.',
  'MC-SMP (https://mc-smp.page) is a Minecraft server and SMP directory.',
  'Enzonic.dev (https://enzonic.dev) is the developer portal for the Enzonic API.',
  'The remaining listed partner domains are https://remy.enzonic.com, https://database.enzonic.com, https://clips.enzonic.com and https://mai.enzonic.com. Do not invent features for them when they are not stated here.',
  'AnyServer (https://anyserver.pro) is also a ScoutCode partner.',
];

// Focus of the bot: ScoutCode first, general questions second.
const SUPPORT_FOCUS = [
  'Your main job is support for ScoutCode: the website (scoutcode.dev) and the Scout desktop app. Help users install it, sign in, use it, understand what it does and fix problems with it.',
  'Answer general questions too (programming, tech, everyday questions). Keep those short and let the user know ScoutCode support is your focus.',
  'For questions about ScoutCode, use the facts below first. For current or outside information (versions, news, other products, anything that may have changed), use the web_search tool instead of guessing.',
  'If a question is about ScoutCode and the facts below do not cover it, say so and point to https://scoutcode.dev or the GitHub repo. Never make up features, prices, limits or dates.',
];

module.exports = { SCOUTCODE, SUPPORT_FOCUS };
