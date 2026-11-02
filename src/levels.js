const { AttachmentBuilder, Events } = require('discord.js');
const store = require('./storage');
const { renderRankCard } = require('./rankcard');

const XP_MIN = 15;
const XP_MAX = 25;
const COOLDOWN_MS = 60_000;
const DELETE_AFTER_MS = 2 * 60_000;
const CHECK_EVERY_MS = 5_000;

const lastXpAt = new Map(); // `${guildId}:${userId}` -> timestamp, only used to rate-limit XP
const voiceLastAt = new Map(); // same key -> last time voice presence was credited
const voiceXpAt = new Map(); // same key -> last voice XP award
const VOICE_XP_COOLDOWN_MS = 60_000;
const VOICE_MAX_TICK_MS = CHECK_EVERY_MS * 3; // never credit a long gap (restart, host sleep)

// Levels live on the guild record in store.json, so XP, ranks and pending deletions survive restarts.
function levelsConfig(guildId) {
  const guild = store.guild(guildId);
  guild.levels ??= { enabled: true, theme: 'claude', users: {}, pending: [] };
  return guild.levels;
}

// Total XP needed to reach a level: 100 for level 1, 300 for level 2, 600 for level 3, and so on.
const totalXp = (level) => 50 * level * (level + 1);

function levelFor(xp) {
  let level = 0;
  while (totalXp(level + 1) <= xp) level += 1;
  return level;
}

function progressOf(xp) {
  const level = levelFor(xp);
  return { level, floor: totalXp(level), next: totalXp(level + 1) };
}

// Ranks are computed from the stored XP, so they stay correct after any /xp change.
function rankOf(cfg, userId) {
  const sorted = Object.entries(cfg.users).sort(([, a], [, b]) => b.xp - a.xp);
  const index = sorted.findIndex(([id]) => id === userId);
  return index === -1 ? sorted.length + 1 : index + 1;
}

function setXp(guildId, userId, xp) {
  const cfg = levelsConfig(guildId);
  const current = cfg.users[userId] ?? { xp: 0, messages: 0 };
  cfg.users[userId] = { ...current, xp: Math.max(0, Math.floor(xp)) };
  store.save();
  return cfg.users[userId].xp;
}

async function cardFor(user, guildId) {
  const cfg = levelsConfig(guildId);
  const record = cfg.users[user.id] ?? { xp: 0, messages: 0 };
  const xp = record.xp;
  const { level, floor, next } = progressOf(xp);
  return renderRankCard({
    username: user.globalName ?? user.username,
    avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256 }),
    themeId: cfg.theme,
    level,
    xp,
    floor,
    next,
    rank: rankOf(cfg, user.id),
    messages: record.messages ?? 0,
    voiceMs: record.voiceMs ?? 0,
  });
}

// The level-up card is announced in any text channel (the member's chat, or the system channel
// when the level came from voice) and deleted by the scheduler after 2 minutes.
async function announceLevelUp(channel, user, level, cfg, guildId) {
  const png = await cardFor(user, guildId);
  const file = new AttachmentBuilder(png, { name: 'level-up.png' });
  const sent = await channel
    .send({
      content: `🎉 <@${user.id}> reached **level ${level}**!`,
      files: [file],
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  if (!sent) return;

  // Deleted by the scheduler after 2 minutes. Stored in store.json, so the timer survives restarts.
  cfg.pending.push({ channelId: sent.channelId, messageId: sent.id, deleteAt: Date.now() + DELETE_AFTER_MS });
  store.save();
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const cfg = levelsConfig(message.guild.id);
  if (!cfg.enabled) return;

  // Every message is counted, even while XP is on cooldown, so the card's total stays true.
  const user = (cfg.users[message.author.id] ??= { xp: 0, messages: 0 });
  user.messages += 1;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if (now - (lastXpAt.get(key) ?? 0) < COOLDOWN_MS) {
    store.save();
    return;
  }
  lastXpAt.set(key, now);

  const before = levelFor(user.xp);
  user.xp += XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  store.save();

  const after = levelFor(user.xp);
  if (after > before) await announceLevelUp(message.channel, message.author, after, cfg, message.guild.id);
}

// XP for voice: run from the 5s sweep, crediting the real time each member spent connected.
// Bots, AFK channels and guilds with levels off are ignored; a member who left and returns does
// not earn the time away.
async function creditVoice(client, now = Date.now()) {
  const live = new Set();
  const levelUps = [];
  let changed = false;

  for (const guild of client.guilds.cache.values()) {
    const cfg = levelsConfig(guild.id);
    if (!cfg.enabled) continue;

    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.channelId === guild.afkChannelId) continue;
      const member = state.member;
      if (!member || member.user.bot) continue;

      const key = `${guild.id}:${member.id}`;
      live.add(key);
      const prev = voiceLastAt.get(key);
      voiceLastAt.set(key, now);
      // First sight: we do not know when they joined, so start tracking without crediting.
      if (!prev) {
        voiceXpAt.set(key, now);
        continue;
      }

      const user = (cfg.users[member.id] ??= { xp: 0, messages: 0 });
      user.voiceMs = (user.voiceMs ?? 0) + Math.min(now - prev, VOICE_MAX_TICK_MS);
      changed = true;

      if (now - (voiceXpAt.get(key) ?? now) < VOICE_XP_COOLDOWN_MS) continue;
      voiceXpAt.set(key, now);
      const before = levelFor(user.xp);
      user.xp += XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
      const after = levelFor(user.xp);
      if (after > before) levelUps.push({ guild, member, level: after, cfg });
    }
  }

  // Drop members no longer in voice so a later return does not credit the gap.
  for (const key of [...voiceLastAt.keys()]) {
    if (live.has(key)) continue;
    voiceLastAt.delete(key);
    voiceXpAt.delete(key);
  }
  if (changed) store.save();

  for (const up of levelUps) {
    const channel = up.guild.systemChannelId
      ? await up.guild.channels.fetch(up.guild.systemChannelId).catch(() => null)
      : null;
    if (!channel?.isTextBased()) continue;
    await announceLevelUp(channel, up.member.user, up.level, up.cfg, up.guild.id).catch(() => {});
  }
}

// Deletes level-up messages whose 2 minutes are over, including ones that were due while the bot
// was offline, and credits voice XP on the same 5s beat.
function startScheduler(client) {
  const sweep = async () => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      const cfg = store.data.guilds[guild.id]?.levels;
      const due = cfg?.pending?.filter((p) => p.deleteAt <= now) ?? [];
      for (const p of due) {
        const channel = await guild.channels.fetch(p.channelId).catch(() => null);
        const message = channel?.isTextBased() ? await channel.messages.fetch(p.messageId).catch(() => null) : null;
        await message?.delete().catch(() => {});
      }
      if (due.length) {
        cfg.pending = cfg.pending.filter((p) => p.deleteAt > now);
        store.save();
      }
    }
    await creditVoice(client, now);
  };
  sweep().catch((err) => console.error('Level sweep failed:', err.message));
  setInterval(() => sweep().catch((err) => console.error('Level sweep failed:', err.message)), CHECK_EVERY_MS);
}

function register(client) {
  // Returns the promise so tests can await the whole XP flow (announce included).
  client.on(Events.MessageCreate, (message) =>
    handleMessage(message).catch((err) => console.error('XP update failed:', err.message)));
}

module.exports = {
  levelsConfig,
  levelFor,
  totalXp,
  progressOf,
  rankOf,
  setXp,
  cardFor,
  announceLevelUp,
  creditVoice,
  register,
  startScheduler,
};
