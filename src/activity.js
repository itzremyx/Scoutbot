const store = require('./storage');

// Chronological journal of what happens to the server: tickets, appeals, security hits,
// dashboard controls and other notable events. It lives on the guild record so it survives a
// restart and feeds both the dashboard activity page and the weekly owner report.
const MAX_ENTRIES = 800;
const RETENTION_MS = 90 * 86_400_000;

function entries(guildId) {
  const guild = store.guild(guildId);
  guild.activity ??= [];
  return guild.activity;
}

function record(guildId, { kind = 'system', title, detail = '', userId = null, meta = null, at = Date.now() } = {}) {
  const list = entries(guildId);
  const entry = {
    id: (list[list.length - 1]?.id ?? 0) + 1,
    kind,
    title: String(title || 'Event').slice(0, 160),
    detail: String(detail || '').slice(0, 1200),
    userId: userId ? String(userId) : null,
    at,
    meta: meta ?? null,
  };
  list.push(entry);

  const cutoff = at - RETENTION_MS;
  while (list.length > MAX_ENTRIES || (list.length > 1 && list[0].at < cutoff)) list.shift();
  store.save();
  return entry;
}

// Newest first. Optionally filtered by kind and/or a lower timestamp.
function recent(guildId, limit = 50, { kind = null, since = 0 } = {}) {
  return entries(guildId)
    .filter((entry) => (!kind || entry.kind === kind) && entry.at >= since)
    .slice(-limit)
    .reverse();
}

function countSince(guildId, since, kind = null) {
  return entries(guildId).filter((entry) => entry.at >= since && (!kind || entry.kind === kind)).length;
}

module.exports = { record, recent, countSince, entries, MAX_ENTRIES, RETENTION_MS };
