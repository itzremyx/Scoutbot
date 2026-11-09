const fs = require('fs');
const path = require('path');
const config = require('./config');
const loader = require('./loader');
const budget = require('./budget');
const backups = require('./backups');
const activity = require('./activity');

// Real, owner-facing actions exposed by the dashboard. Each one returns a short user-facing
// message and records itself in the activity journal so there is a trail of who did what.
const PRUNE_DAYS = 90;

function guildOf(client) {
  return client.guilds.cache.get(config.mainGuildId)
    ?? null;
}

async function reloadConfig(client) {
  config.reload();
  const count = await loader.reload(client);
  activity.record(config.mainGuildId, {
    kind: 'control',
    title: 'Reload from dashboard',
    detail: `Configuration reloaded and ${count} slash commands re-registered.`,
  });
  return { ok: true, message: `Configuration reloaded, ${count} slash commands re-registered.` };
}

async function syncCommands(client) {
  const count = await loader.registerCommands(client, config.mainGuildId);
  activity.record(config.mainGuildId, {
    kind: 'control',
    title: 'Slash commands synced',
    detail: `${count} commands registered to the server.`,
  });
  return { ok: true, message: `${count} slash commands synced.` };
}

function resetAiUsage() {
  budget.resetToday();
  activity.record(config.mainGuildId, {
    kind: 'control',
    title: 'AI usage reset',
    detail: 'Today\'s token, call and image counters were reset.',
  });
  return { ok: true, message: 'Today\'s AI usage counters were reset.' };
}

function createBackup(client) {
  const guild = guildOf(client);
  if (!guild) return { ok: false, message: 'The main server is not cached yet.' };
  const backup = backups.createBackup(guild, 'Manual backup (dashboard)', client.user.id);
  activity.record(guild.id, {
    kind: 'control',
    title: 'Backup created from dashboard',
    detail: `Backup #${backup.id}: ${backup.roles.length} roles, ${backup.channels.length} channels.`,
  });
  return { ok: true, message: `Backup #${backup.id} created (${backup.roles.length} roles, ${backup.channels.length} channels).` };
}

// Deletes transcript files older than PRUNE_DAYS, along with their JSON sidecars.
function pruneTranscripts(days = PRUNE_DAYS) {
  const dir = config.transcriptDir;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { ok: true, message: 'No transcript directory yet, nothing to prune.', removed: 0 };
  }
  for (const name of entries) {
    if (!name.endsWith('.txt')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat || stat.mtimeMs >= cutoff) continue;
    fs.unlinkSync(full);
    const sidecar = path.join(dir, name.replace(/\.txt$/, '.json'));
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    removed += 1;
  }
  activity.record(config.mainGuildId, {
    kind: 'control',
    title: 'Old transcripts pruned',
    detail: `${removed} transcript(s) older than ${days} days were deleted.`,
  });
  return { ok: true, message: `${removed} transcript(s) older than ${days} days deleted.`, removed };
}

function restart() {
  activity.record(config.mainGuildId, {
    kind: 'control',
    title: 'Restart requested from dashboard',
    detail: 'The process is exiting so the panel can start it again.',
  });
  // Give the HTTP response time to reach the browser before the process goes away.
  setTimeout(() => {
    console.log('[dashboard] restart requested, exiting');
    process.exit(0);
  }, 800);
  return { ok: true, message: 'Restarting the bot now…' };
}

const ACTIONS = {
  'reload-config': (client) => reloadConfig(client),
  'sync-commands': (client) => syncCommands(client),
  'reset-ai-usage': () => resetAiUsage(),
  'create-backup': (client) => createBackup(client),
  'prune-transcripts': () => pruneTranscripts(),
  restart: () => restart(),
};

async function run(action, client) {
  const handler = ACTIONS[action];
  if (!handler) return { ok: false, message: `Unknown action: ${action}` };
  return handler(client);
}

module.exports = { run, ACTIONS, pruneTranscripts, PRUNE_DAYS };
