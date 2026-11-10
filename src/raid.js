const { Events } = require('discord.js');
const store = require('./storage');
const activity = require('./activity');
const health = require('./health');
const { addModlogEntry } = require('./modlog');
const { post } = require('./logs');

// Raid protection: while the window is open every non-bot join is handled, and a sudden flood of
// joins can turn the mode on automatically. The defaults are deliberately conservative so a busy
// server does not trip on a normal welcome wave.
const DEFAULTS = {
  enabled: false,
  endsAt: null,
  timeoutMinutes: 30,
  autoEnabled: true,
  joinThreshold: 8,
  joinWindowSeconds: 20,
  minAccountAgeHours: 24,
  kickYoung: true,
  actions: 0,
  lastTriggerAt: null,
  lastActionAt: null,
};

const MAX_TIMEOUT_MINUTES = 1440;
const MAX_WINDOW_SECONDS = 600;
const MAX_ACCOUNT_AGE_HOURS = 720;
const MAX_JOIN_HISTORY = 500;

const joinWindows = new Map(); // guildId -> array of join timestamps (newest last)

function raidConfig(guildId) {
  const guild = store.guild(guildId);
  guild.raid ??= {};
  const config = guild.raid;
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (config[key] === undefined) config[key] = value;
  }
  return config;
}

function isRaidActive(guildId) {
  const config = raidConfig(guildId);
  return Boolean(config.enabled && config.endsAt && config.endsAt > Date.now());
}

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

// Counts the joins that happened inside the configured window and remembers this one too.
function joinCount(guildId, windowSeconds) {
  const now = Date.now();
  const cutoff = now - Math.max(1, windowSeconds) * 1000;
  const list = (joinWindows.get(guildId) ?? []).filter((at) => at >= cutoff);
  list.push(now);
  if (list.length > MAX_JOIN_HISTORY) list.splice(0, list.length - MAX_JOIN_HISTORY);
  joinWindows.set(guildId, list);
  return list.length;
}

function setRaid(guildId, patch = {}, options = {}) {
  const config = raidConfig(guildId);

  if (patch.timeoutMinutes !== undefined) {
    config.timeoutMinutes = clamp(patch.timeoutMinutes, 1, MAX_TIMEOUT_MINUTES, config.timeoutMinutes);
  }
  if (patch.autoEnabled !== undefined) config.autoEnabled = Boolean(patch.autoEnabled);
  if (patch.joinThreshold !== undefined) {
    config.joinThreshold = clamp(patch.joinThreshold, 2, 100, config.joinThreshold);
  }
  if (patch.joinWindowSeconds !== undefined) {
    config.joinWindowSeconds = clamp(patch.joinWindowSeconds, 3, MAX_WINDOW_SECONDS, config.joinWindowSeconds);
  }
  if (patch.minAccountAgeHours !== undefined) {
    config.minAccountAgeHours = clamp(patch.minAccountAgeHours, 0, MAX_ACCOUNT_AGE_HOURS, config.minAccountAgeHours);
  }
  if (patch.kickYoung !== undefined) config.kickYoung = Boolean(patch.kickYoung);

  if (typeof patch.enabled === 'boolean') {
    config.enabled = patch.enabled;
    config.endsAt = patch.enabled ? Date.now() + config.timeoutMinutes * 60_000 : null;
    if (patch.enabled) config.lastTriggerAt = Date.now();
  }

  store.save();
  if (options.record) {
    activity.record(guildId, {
      kind: 'security',
      title: patch.enabled === true ? 'Raid mode enabled' : patch.enabled === false ? 'Raid mode disabled' : 'Raid settings updated',
      detail: options.detail || 'Changed from the dashboard.',
      userId: options.actorId ?? null,
    });
  }
  return config;
}

async function triggerRaid(guild, config, count) {
  config.enabled = true;
  config.endsAt = Date.now() + config.timeoutMinutes * 60_000;
  config.lastTriggerAt = Date.now();
  store.save();

  const detail = `${count} joins in ${config.joinWindowSeconds}s triggered raid mode for ${config.timeoutMinutes} min. New members are timed out${config.kickYoung ? ' and very young accounts are kicked' : ''}.`;
  activity.record(guild.id, { kind: 'security', title: 'Raid mode auto-enabled', detail });
  addModlogEntry(guild.id, {
    userId: guild.client?.user?.id ?? null,
    action: 'raid',
    reason: detail,
    moderatorId: null,
  });

  await post(guild, 'error', 'Raid protection auto-enabled', [
    ['Join rate', `${count} joins in ${config.joinWindowSeconds}s`, true],
    ['Timeout', `${config.timeoutMinutes} min`, true],
    ['Ends', `<t:${Math.floor(config.endsAt / 1000)}:R>`, true],
  ]).catch(() => {});

  await health
    .alertOwner('Raid protection auto-enabled', `${guild.name} (${guild.id})\n${detail}`, {
      key: `raid:${guild.id}`,
    })
    .catch(() => {});
}

// Handles one member joining. Returns a short outcome for tests and logs.
async function handleJoin(member) {
  if (!member?.guild || member.user?.bot) return null;
  const guild = member.guild;
  const config = raidConfig(guild.id);
  const count = joinCount(guild.id, config.joinWindowSeconds);

  if (!isRaidActive(guild.id) && config.autoEnabled && count >= config.joinThreshold) {
    await triggerRaid(guild, config, count);
  }

  if (!isRaidActive(guild.id)) return null;

  config.actions = (config.actions ?? 0) + 1;
  config.lastActionAt = Date.now();
  const ageMs = Date.now() - (member.user.createdTimestamp ?? Date.now());
  const tooYoung = ageMs < (config.minAccountAgeHours ?? 0) * 3_600_000;

  let outcome = 'observed';
  if (config.kickYoung && tooYoung && member.kickable) {
    const hours = Math.max(1, Math.round(ageMs / 3_600_000));
    const reason = `Raid protection: account only ${hours}h old`;
    const kicked = await member.kick(reason).then(() => true).catch(() => false);
    if (kicked) {
      outcome = 'kicked';
      activity.record(guild.id, {
        kind: 'security',
        title: 'Young account kicked during raid',
        detail: `${member.user?.tag ?? member.id} (${hours}h old) was kicked.`,
        userId: member.id,
      });
      addModlogEntry(guild.id, {
        userId: member.id,
        action: 'kick',
        reason,
        moderatorId: guild.client?.user?.id ?? null,
      });
    }
  } else if (config.timeoutMinutes > 0) {
    const timedOut = await member
      .timeout(config.timeoutMinutes * 60_000, 'Raid protection: joined during raid mode')
      .then(() => true)
      .catch(() => false);
    if (timedOut) outcome = 'timed-out';
  }

  store.save();
  return outcome;
}

function register(client) {
  client.on(Events.GuildMemberAdd, (member) => {
    handleJoin(member).catch((err) => console.error('Raid protection failed:', err.message));
  });
}

module.exports = {
  raidConfig,
  isRaidActive,
  setRaid,
  handleJoin,
  joinCount,
  register,
  DEFAULTS,
  MAX_TIMEOUT_MINUTES,
  MAX_WINDOW_SECONDS,
  MAX_ACCOUNT_AGE_HOURS,
};
