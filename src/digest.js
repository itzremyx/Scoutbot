const store = require('./storage');
const { makeEmbed } = require('./utils');

// Weekly server digest: joins, leaves, moderation actions, XP and invites, posted to the
// configured channel every Monday at 09:00 UTC. Joins/leaves are week counters, reset after
// each post; moderation is filtered by timestamp since the last post.

// Actions considered "moderation" for the digest (warn/kick/ban/timeout, logged by src/modlog.js).
const MOD_ACTIONS = new Set(['warn', 'automod', 'kick', 'ban', 'timeout']);

const CHECK_INTERVAL_MS = 60_000; // wake up every minute and see if it is time
const DIGEST_DAY = 1; // Monday (0 = Sunday)
const DIGEST_HOUR = 9; // 09:00 UTC
const DIGEST_MINUTE = 0;
const MAX_INVITERS = 5;

const ACTION_LABEL = {
  warn: 'Warnings',
  automod: 'Auto-mod',
  kick: 'Kicks',
  ban: 'Bans',
  timeout: 'Timeouts',
};

// State lives on the guild record: previous post timestamp, so a restart does not double-post.
function configFor(guildId) {
  const guild = store.guild(guildId);
  guild.weeklyDigest ??= { channelId: '1566492359460659260' };
  return guild.weeklyDigest;
}

// Post the digest for this guild. Exported for tests; normally called by runDigest.
async function postDigest(guild) {
  const cfg = configFor(guild.id);
  if (!cfg.channelId) return null;
  const channel = guild.client.channels.cache.get(cfg.channelId);
  if (!channel?.isTextBased()) return null;

  const g = store.guild(guild.id);
  const members = guild.memberCount;
  const joins = g.joins ?? 0;
  const leaves = g.leaves ?? 0;
  const since = cfg.lastPostedAt ?? 0;
  const modlog = (g.modlog?.entries ?? []).filter((e) => MOD_ACTIONS.has(e.action) && (e.at ?? 0) >= since);

  const lines = [`**Members:** ${members}`, `**Joined this week:** ${joins}`, `**Left this week:** ${leaves}`];

  const modCounts = new Map();
  for (const e of modlog) modCounts.set(e.action, (modCounts.get(e.action) ?? 0) + 1);
  if (modCounts.size) {
    const names = [...modCounts.entries()].map(([action, n]) => `${ACTION_LABEL[action] ?? action}: ${n}`).join(', ');
    lines.push(`**Moderation:** ${names}`);
  }

  const levels = g.levels?.users ?? {};
  const topXp = Object.entries(levels)
    .sort(([, a], [, b]) => (b.xp ?? 0) - (a.xp ?? 0))
    .slice(0, 3)
    .map(([id], i) => `${i + 1}. <@${id}>`)
    .join(' · ');
  if (topXp) lines.push(`**Top XP:** ${topXp}`);

  const invites = Object.entries(g.invites ?? {}).sort(([, a], [, b]) => (b.regular ?? 0) - (a.regular ?? 0)).slice(0, MAX_INVITERS);
  if (invites.length) {
    const list = invites.map(([id, e]) => `\`${e.regular ?? 0}\` <@${id}>`).join(' · ');
    lines.push(`**Top inviters:** ${list}`);
  }

  const ts = Math.floor(Date.now() / 1000);
  const embed = makeEmbed('info', 'Weekly digest', `Server stats for <t:${ts}:R>\n${lines.join('\n')}`);
  const sent = await channel.send({ embeds: [embed] }).catch(() => null);
  if (sent) {
    // Counters are week-scoped: reset after a successful post so "this week" never accumulates.
    g.joins = 0;
    g.leaves = 0;
    cfg.lastPostedAt = Date.now();
    store.save();
  }
  return sent;
}

// Called every minute: post for each guild whose digest is due and not yet posted.
async function runDigest(client, now = Date.now()) {
  const nowDay = new Date(now);
  if (nowDay.getUTCDay() !== DIGEST_DAY || nowDay.getUTCHours() !== DIGEST_HOUR || nowDay.getUTCMinutes() !== DIGEST_MINUTE) return [];
  const posted = [];
  for (const guild of client.guilds.cache.values()) {
    const cfg = configFor(guild.id);
    if (!cfg.channelId) continue;
    // Only post once per digest window: compare against the last post time, not a wall date,
    // so crossing a week boundary or restarting does not double-post.
    const last = cfg.lastPostedAt ?? 0;
    if (now - last >= 6 * 86_400_000) {
      const sent = await postDigest(guild).catch(() => null);
      if (sent) posted.push(guild.id);
    }
  }
  return posted;
}

function startScheduler(client) {
  const tick = () => runDigest(client).catch((err) => console.error('Weekly digest failed:', err.message));
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}

// Track join/leave counts for the digest on the guild record.
function register(client) {
  client.on('guildMemberAdd', (member) => {
    const g = store.guild(member.guild.id);
    g.joins = (g.joins ?? 0) + 1;
    store.save();
  });
  client.on('guildMemberRemove', (member) => {
    const g = store.guild(member.guild.id);
    g.leaves = (g.leaves ?? 0) + 1;
    store.save();
  });
}

module.exports = {
  configFor,
  postDigest,
  runDigest,
  startScheduler,
  register,
  ACTION_LABEL,
};
