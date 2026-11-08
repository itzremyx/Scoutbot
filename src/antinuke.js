const { AuditLogEvent, Events } = require('discord.js');
const config = require('./config');
const store = require('./storage');
const raid = require('./raid');
const health = require('./health');
const { post } = require('./logs');

// Anti-nuke: watches the audit log for a burst of destructive actions by the same account.
// It never punishes anyone on its own; it logs, alerts the owner and turns on raid protection
// (which only times out members who join while the window is open).
const WINDOW_MS = 60_000;
const THRESHOLD = 5;
const AUDIT_LOOKBACK_MS = 10_000;

const EVENTS = {
  [Events.ChannelDelete]: { type: AuditLogEvent.ChannelDelete, target: (arg) => arg?.id },
  [Events.RoleDelete]: { type: AuditLogEvent.RoleDelete, target: (arg) => arg?.id },
  [Events.GuildBanAdd]: { type: AuditLogEvent.MemberBanAdd, target: (ban) => ban?.user?.id },
  [Events.GuildMemberRemove]: { type: AuditLogEvent.MemberKick, target: (member) => member?.id },
};

const history = new Map(); // `${guildId}:${userId}` -> array of action timestamps
const alerted = new Map(); // `${guildId}:${userId}` -> timestamp of the last alert

function track(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const list = (history.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  list.push(now);
  history.set(key, list);
  return list.length;
}

async function executorOf(guild, type, targetId) {
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  if (!logs) return null;
  const entry = logs.entries.find(
    (item) => item.targetId === targetId && Date.now() - item.createdTimestamp < AUDIT_LOOKBACK_MS,
  );
  return entry?.executor ?? null;
}

function isTrusted(guild, user) {
  if (!user) return true;
  if (user.id === guild.client.user?.id) return true;
  if (user.id === guild.ownerId) return true;
  if (user.id === config.owner.id) return true;
  return false;
}

async function onDestructiveAction(guild, user) {
  if (!guild || isTrusted(guild, user)) return;
  const count = track(guild.id, user.id);
  if (count < THRESHOLD) return;

  // One alert per window and account: the counter keeps climbing, the alert must not.
  const key = `${guild.id}:${user.id}`;
  const last = alerted.get(key) ?? 0;
  if (Date.now() - last < WINDOW_MS) return;
  alerted.set(key, Date.now());

  const raidConfig = raid.raidConfig(guild.id);
  const alreadyActive = raidConfig.enabled && raidConfig.endsAt > Date.now();
  if (!alreadyActive) {
    raidConfig.enabled = true;
    raidConfig.endsAt = Date.now() + 30 * 60_000;
    store.save();
  }

  const summary = [
    `**Account:** ${user.tag ?? user.username ?? user.id} (<@${user.id}>)`,
    `**Destructive actions:** ${count} in the last ${Math.round(WINDOW_MS / 60_000)} minute(s)`,
    `**Server:** ${guild.name} (${guild.id})`,
    `**Raid protection:** ${alreadyActive ? 'already active' : 'turned on for 30 minutes'}`,
  ].join('\n');

  await post(guild, 'error', '🚨 Possible nuke detected', [
    ['Account', `<@${user.id}> (${user.tag ?? user.id})`, true],
    ['Actions', `${count} in ${Math.round(WINDOW_MS / 60_000)} min`, true],
    ['Raid protection', alreadyActive ? 'already active' : 'turned on (30 min)', true],
  ]);

  await health
    .alertOwner('Possible nuke detected', `${summary}\n\nRaid protection is on. Use /lockdown if the attack continues.`, {
      key: `nuke:${guild.id}:${user.id}`,
    })
    .catch(() => {});
}

function register(client) {
  for (const [eventName, definition] of Object.entries(EVENTS)) {
    client.on(eventName, async (...args) => {
      const guild = args.find((arg) => arg?.guild)?.guild ?? null;
      if (!guild) return;
      const targetId = definition.target(args[0]);
      if (!targetId) return;
      const executor = await executorOf(guild, definition.type, targetId);
      await onDestructiveAction(guild, executor).catch((err) => console.error('Anti-nuke error:', err.message));
    });
  }
}

module.exports = { register, THRESHOLD, WINDOW_MS };
