const store = require('./storage');
const { addModlogEntry } = require('./modlog');
const { dmUser, makeEmbed, sendLog } = require('./utils');

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_MS = 60_000;
const MAX_MS = 30 * UNITS.d;
const CHECK_EVERY_MS = 60_000;

// Accepts "90s", "10m", "2h", "1d" and combinations such as "1h 30m". Returns null when invalid.
function parseDuration(text, max = MAX_MS) {
  if (typeof text !== 'string' || !/^(\d+\s*[smhd]\s*)+$/i.test(text.trim())) return null;
  const ms = [...text.matchAll(/(\d+)\s*([smhd])/gi)].reduce(
    (sum, [, amount, unit]) => sum + Number(amount) * UNITS[unit.toLowerCase()],
    0,
  );
  return ms >= MIN_MS && ms <= max ? ms : null;
}

// Temporary punishments live on the guild record in store.json so they survive restarts:
// the scheduler unbans / lifts a mute once expiresAt is reached, even after a redeploy.
function punishmentsConfig(guildId) {
  const guild = store.guild(guildId);
  guild.punishments ??= { nextId: 1, items: {} };
  return guild.punishments;
}

function addPunishment(guildId, { type, userId, reason, moderatorId, expiresAt }) {
  const cfg = punishmentsConfig(guildId);
  const id = cfg.nextId;
  cfg.nextId += 1;
  cfg.items[id] = {
    id,
    type,
    userId: String(userId),
    reason,
    moderatorId: moderatorId ? String(moderatorId) : null,
    createdAt: Date.now(),
    expiresAt,
    active: true,
  };
  store.save();
  return cfg.items[id];
}

function findPunishment(guildId, id) {
  return punishmentsConfig(guildId).items[id] ?? null;
}

function listPunishments(guildId, { activeOnly = true } = {}) {
  return Object.values(punishmentsConfig(guildId).items)
    .filter((item) => (activeOnly ? item.active : true))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

// Marks a punishment as served so the scheduler leaves it alone. Returns the item or null.
function clearPunishment(guildId, id) {
  const item = findPunishment(guildId, id);
  if (!item || !item.active) return null;
  item.active = false;
  store.save();
  return item;
}

// Used when a moderator lifts a ban or timeout by hand, so the scheduler does not repeat it.
function clearForUser(guildId, userId, type) {
  let cleared = 0;
  for (const item of listPunishments(guildId)) {
    if (item.userId !== String(userId) || item.type !== type) continue;
    item.active = false;
    cleared += 1;
  }
  if (cleared) store.save();
  return cleared;
}

async function expirePunishment(guild, item) {
  item.active = false;

  if (item.type === 'tempban') {
    const banned = await guild.bans.fetch(item.userId).catch(() => null);
    if (banned) {
      await guild.bans.remove(item.userId, 'Temporary ban expired').catch(() => {});
    }
    addModlogEntry(guild.id, { userId: item.userId, action: 'tempban_expired', reason: 'Temporary ban expired' });
    await sendLog(guild, {
      embeds: [makeEmbed('success', 'Temporary ban expired', `**Member:** <@${item.userId}> (${item.userId})`)],
    });
    const user = await guild.client.users.fetch(item.userId).catch(() => null);
    if (user) {
      await dmUser(user, makeEmbed('success', `Your ban in ${guild.name} expired`, 'You can join the server again.'));
    }
  }

  if (item.type === 'tempmute') {
    const member = await guild.members.fetch(item.userId).catch(() => null);
    if (member?.isCommunicationDisabled()) {
      await member.timeout(null, 'Temporary mute expired').catch(() => {});
    }
    addModlogEntry(guild.id, { userId: item.userId, action: 'tempmute_expired', reason: 'Temporary mute expired' });
    await sendLog(guild, {
      embeds: [makeEmbed('success', 'Temporary mute expired', `**Member:** <@${item.userId}> (${item.userId})`)],
    });
  }

  store.save();
}

function startScheduler(client) {
  const check = async () => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      const items = listPunishments(guild.id).filter((item) => item.expiresAt <= now);
      for (const item of items) {
        await expirePunishment(guild, item).catch((err) =>
          console.error(`Punishment #${item.id} expiry failed:`, err.message),
        );
      }
    }
  };
  check();
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = {
  MIN_MS,
  MAX_MS,
  parseDuration,
  punishmentsConfig,
  addPunishment,
  findPunishment,
  listPunishments,
  clearPunishment,
  clearForUser,
  startScheduler,
};
