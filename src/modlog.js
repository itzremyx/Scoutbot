const { PermissionFlagsBits } = require('discord.js');
const store = require('./storage');

// Journal of every moderator action on a member (plus auto-mod and purges), kept per guild on
// the guild record in store.json. /warn keeps its own list of active warnings; each warning is
// journaled here too, so a warning that was removed later still shows in the history.
// Entry: { id, userId, action, reason, moderatorId, at, meta }
const MAX_ENTRIES = 500;
const RETENTION_MS = 365 * 86_400_000;
const MAX_REASON = 400;

// Same permission as /warnings: seeing someone else's history is a moderator action.
// (Viewing your own entries is allowed for everyone, checked in the command.)
const VIEW_PERMISSION = PermissionFlagsBits.ModerateMembers;

// Actions that point at an active warning through meta.warningId. Once that warning is removed
// from the active list, the entry is marked "(since removed)" in the view.
const WARNING_ACTIONS = new Set(['warn', 'automod', 'automod_timeout']);

const ACTION_LABEL = {
  warn: 'Warning',
  unwarn: 'Warning removed',
  automod: 'Auto-mod warning',
  automod_timeout: 'Auto-mod timeout',
  kick: 'Kicked',
  ban: 'Banned',
  unban: 'Unbanned',
  timeout: 'Timed out',
  untimeout: 'Timeout removed',
  purge: 'Messages purged',
  nickname: 'Nickname changed',
  raid: 'Raid mode',
  invite_link: 'Invite link removed',
  phishing: 'Phishing link removed',
  lockdown: 'Server locked down',
  unlockdown: 'Lockdown off',
};

function modlogConfig(guildId) {
  const guild = store.guild(guildId);
  guild.modlog ??= { nextId: 1, entries: [] };
  return guild.modlog;
}

// Records one action and saves the store. `at` is only meant for tests.
function addModlogEntry(guildId, { userId, action, reason = '', moderatorId = null, at = Date.now(), meta = {} }) {
  const log = modlogConfig(guildId);
  const entry = {
    id: log.nextId++,
    userId: String(userId),
    action,
    reason: String(reason).slice(0, MAX_REASON),
    moderatorId: moderatorId ? String(moderatorId) : null,
    at,
    meta,
  };
  log.entries.push(entry);

  // Oldest first for the view: entries past the age or count limit are dropped.
  const cutoff = at - RETENTION_MS;
  while (log.entries.length > MAX_ENTRIES || (log.entries.length > 1 && log.entries[0].at < cutoff)) {
    log.entries.shift();
  }
  store.save();
  return entry;
}

const findModlogEntry = (guildId, entryId) =>
  modlogConfig(guildId).entries.find((e) => e.id === entryId) ?? null;

const labelOf = (entry) => ACTION_LABEL[entry.action] ?? entry.action;

// The warning an entry created, when it is still active; otherwise null (removed since).
function activeWarningFor(guildId, entry) {
  const warningId = entry.meta?.warningId;
  if (warningId === undefined || !WARNING_ACTIONS.has(entry.action)) return null;
  return (store.guild(guildId).warnings[entry.userId] ?? []).find((w) => w.id === warningId) ?? null;
}

// Removes a warning from the active list (the one /warnings and /unwarn work on).
// Returns the warning, or null when the id does not exist.
function removeWarningEntry(guildId, userId, warningId) {
  const settings = store.guild(guildId);
  const list = settings.warnings[userId] ?? [];
  const index = list.findIndex((w) => w.id === warningId);
  if (index === -1) return null;

  const [removed] = list.splice(index, 1);
  if (!list.length) delete settings.warnings[userId];
  store.save();
  return removed;
}

const warnCount = (guildId, userId) => (store.guild(guildId).warnings[userId] ?? []).length;

module.exports = {
  VIEW_PERMISSION,
  MAX_ENTRIES,
  modlogConfig,
  addModlogEntry,
  findModlogEntry,
  labelOf,
  activeWarningFor,
  removeWarningEntry,
  warnCount,
};
