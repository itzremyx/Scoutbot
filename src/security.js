const config = require('./config');
const store = require('./storage');
const activity = require('./activity');
const raid = require('./raid');
const antiphish = require('./antiphish');
const automod = require('./automod');
const alts = require('./alts');
const antinuke = require('./antinuke');
const { modlogConfig } = require('./modlog');

// Read/write helpers behind the dashboard security page. Everything is stored on the guild record
// so the bot and the panel always agree, and every change is written to the activity journal.
const DAY_MS = 86_400_000;
const SECURITY_ACTIONS = new Set(['phishing', 'invite_link', 'raid', 'automod', 'lockdown', 'unlockdown']);
const ACTION_LABEL = {
  phishing: 'Phishing link removed',
  invite_link: 'Invite link removed',
  raid: 'Raid protection',
  automod: 'Auto-moderation',
  lockdown: 'Lockdown',
  unlockdown: 'Lockdown off',
};

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

function recentSecurityEvents(guildId, limit = 60) {
  const recorded = activity.recent(guildId, limit, { kind: 'security' }).map((entry) => ({
    id: `a${entry.id}`,
    source: 'activity',
    title: entry.title,
    detail: entry.detail,
    at: entry.at,
  }));
  const logged = (modlogConfig(guildId).entries ?? [])
    .filter((entry) => SECURITY_ACTIONS.has(entry.action))
    .slice(-limit)
    .map((entry) => ({
      id: `m${entry.id}`,
      source: 'modlog',
      title: ACTION_LABEL[entry.action] ?? entry.action,
      detail: entry.reason || '',
      at: entry.at,
      userId: entry.userId,
      action: entry.action,
    }));
  return [...recorded, ...logged].sort((a, b) => b.at - a.at).slice(0, limit);
}

function securityData() {
  const guildId = config.mainGuildId;
  const rc = raid.raidConfig(guildId);
  const pc = antiphish.phishConfig(guildId);
  const ac = automod.automodConfig(guildId);
  const since = Date.now() - DAY_MS;
  const entries = modlogConfig(guildId).entries ?? [];

  return {
    raid: {
      active: raid.isRaidActive(guildId),
      enabled: Boolean(rc.enabled),
      endsAt: rc.endsAt ?? null,
      timeoutMinutes: rc.timeoutMinutes,
      autoEnabled: rc.autoEnabled !== false,
      joinThreshold: rc.joinThreshold,
      joinWindowSeconds: rc.joinWindowSeconds,
      minAccountAgeHours: rc.minAccountAgeHours,
      kickYoung: rc.kickYoung !== false,
      actions: rc.actions ?? 0,
      lastTriggerAt: rc.lastTriggerAt ?? null,
      lastActionAt: rc.lastActionAt ?? null,
    },
    antiphish: {
      enabled: pc.enabled !== false,
      timeoutMinutes: pc.timeoutMinutes ?? 0,
    },
    automod: {
      enabled: Boolean(ac.enabled),
      words: [...(ac.words ?? [])],
      count: (ac.words ?? []).length,
      timeoutAt: ac.timeoutAt,
      timeoutMinutes: ac.timeoutMinutes,
      maxWords: automod.MAX_WORDS,
      maxWordLength: automod.WORD_MAX_LENGTH,
    },
    alts: {
      youngDays: Math.max(1, Math.round(alts.YOUNG_ACCOUNT_MS / DAY_MS)),
      mode: 'log-only',
    },
    antinuke: {
      threshold: antinuke.THRESHOLD,
      windowSeconds: Math.round(antinuke.WINDOW_MS / 1000),
    },
    stats: {
      securityToday: activity.countSince(guildId, since, 'security'),
      phishingToday: entries.filter((entry) => entry.action === 'phishing' && entry.at >= since).length,
      invitesToday: entries.filter((entry) => entry.action === 'invite_link' && entry.at >= since).length,
      raidActions: rc.actions ?? 0,
    },
    events: recentSecurityEvents(guildId, 60),
  };
}

function updateRaid(patch = {}, actorId = null) {
  const guildId = config.mainGuildId;
  const before = raid.raidConfig(guildId);
  const wasEnabled = Boolean(before.enabled);
  const cfg = raid.setRaid(guildId, patch, {
    record: true,
    actorId,
    detail: 'Raid settings changed from the dashboard.',
  });
  const changed = [];
  if (typeof patch.enabled === 'boolean' && patch.enabled !== wasEnabled) {
    changed.push(patch.enabled ? 'raid mode enabled' : 'raid mode disabled');
  }
  if (patch.joinThreshold !== undefined) changed.push(`auto-trigger at ${cfg.joinThreshold} joins/${cfg.joinWindowSeconds}s`);
  if (patch.timeoutMinutes !== undefined) changed.push(`timeout ${cfg.timeoutMinutes} min`);
  if (patch.minAccountAgeHours !== undefined) changed.push(`young accounts under ${cfg.minAccountAgeHours}h`);
  return { ok: true, message: changed.length ? `Saved: ${changed.join(', ')}.` : 'Raid settings saved.', data: securityData() };
}

function updateAntiphish(patch = {}, actorId = null) {
  const guildId = config.mainGuildId;
  const cfg = antiphish.phishConfig(guildId);
  if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
  if (patch.timeoutMinutes !== undefined) cfg.timeoutMinutes = clamp(patch.timeoutMinutes, 0, 1440, cfg.timeoutMinutes);
  store.save();
  activity.record(guildId, {
    kind: 'security',
    title: 'Anti-phishing updated',
    detail: `Link filtering ${cfg.enabled ? 'on' : 'off'}${cfg.timeoutMinutes ? `, timeout ${cfg.timeoutMinutes} min` : ''}.`,
    userId: actorId,
  });
  return { ok: true, message: 'Anti-phishing settings saved.', data: securityData() };
}

function updateAutomod(patch = {}, actorId = null) {
  const guildId = config.mainGuildId;
  const cfg = automod.automodConfig(guildId);
  if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
  if (patch.timeoutAt !== undefined) cfg.timeoutAt = clamp(patch.timeoutAt, 1, 20, cfg.timeoutAt);
  if (patch.timeoutMinutes !== undefined) cfg.timeoutMinutes = clamp(patch.timeoutMinutes, 1, 1440, cfg.timeoutMinutes);
  store.save();
  activity.record(guildId, {
    kind: 'security',
    title: 'Auto-moderation updated',
    detail: `Blocked-word filter ${cfg.enabled ? 'on' : 'off'}, timeout after ${cfg.timeoutAt} strike(s).`,
    userId: actorId,
  });
  return { ok: true, message: 'Auto-moderation settings saved.', data: securityData() };
}

function editWord({ action = 'add', word = '' } = {}, actorId = null) {
  const guildId = config.mainGuildId;
  const clean = String(word || '').trim().slice(0, automod.WORD_MAX_LENGTH);
  if (!clean) return { ok: false, message: 'Enter a word first.', data: securityData() };

  const cfg = automod.automodConfig(guildId);
  const lower = clean.toLowerCase();
  const exists = cfg.words.some((item) => item.toLowerCase() === lower);

  if (action === 'remove') {
    if (!exists) return { ok: false, message: `"${clean}" is not blocked.`, data: securityData() };
    cfg.words = cfg.words.filter((item) => item.toLowerCase() !== lower);
    store.save();
    activity.record(guildId, { kind: 'security', title: 'Blocked word removed', detail: `"${clean}" is allowed again.`, userId: actorId });
    return { ok: true, message: `"${clean}" is allowed again.`, data: securityData() };
  }

  if (exists) return { ok: false, message: `"${clean}" is already blocked.`, data: securityData() };
  if (cfg.words.length >= automod.MAX_WORDS) {
    return { ok: false, message: `The list is full (${automod.MAX_WORDS} words).`, data: securityData() };
  }
  cfg.words.push(clean);
  store.save();
  activity.record(guildId, { kind: 'security', title: 'Blocked word added', detail: `"${clean}" is now filtered.`, userId: actorId });
  return { ok: true, message: `"${clean}" is now blocked.`, data: securityData() };
}

function summary() {
  const guildId = config.mainGuildId;
  const rc = raid.raidConfig(guildId);
  const pc = antiphish.phishConfig(guildId);
  const ac = automod.automodConfig(guildId);
  const since = Date.now() - DAY_MS;
  const entries = modlogConfig(guildId).entries ?? [];
  return {
    raidActive: raid.isRaidActive(guildId),
    raidEnabled: Boolean(rc.enabled),
    raidEndsAt: rc.endsAt ?? null,
    raidActions: rc.actions ?? 0,
    antiphish: pc.enabled !== false,
    automod: Boolean(ac.enabled),
    blockedWords: ac.words?.length ?? 0,
    phishingToday: entries.filter((entry) => entry.action === 'phishing' && entry.at >= since).length,
  };
}

module.exports = {
  securityData,
  summary,
  recentSecurityEvents,
  updateRaid,
  updateAntiphish,
  updateAutomod,
  editWord,
  SECURITY_ACTIONS,
};
