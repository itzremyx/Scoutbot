const { ChannelType, PermissionFlagsBits } = require('discord.js');
const store = require('./storage');

const MAX_BACKUPS = 5;
const AUTO_EVERY_MS = 24 * 60 * 60 * 1000;
// Only plain channel types are restored. Threads, forums and media need extra settings that a snapshot does not hold.
const RESTORABLE_TYPES = new Set([ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice]);

function backupsOf(guildId) {
  const guild = store.guild(guildId);
  guild.backups ??= { nextId: 1, items: {} };
  return guild.backups;
}

function snapshotRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
  };
}

function snapshotOverwrites(overwrites) {
  return [...overwrites.values()].map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield.toString(),
    deny: o.deny.bitfield.toString(),
  }));
}

function snapshotChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    position: channel.rawPosition ?? channel.position,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    overwrites: snapshotOverwrites(channel.permissionOverwrites.cache),
  };
}

// Captures roles, categories and channels with their permission overwrites. Stored in store.json.
function createBackup(guild, name, createdBy, { auto = false } = {}) {
  const cfg = backupsOf(guild.id);
  if (auto) {
    // There is only ever one automatic snapshot: the previous one is replaced.
    for (const item of Object.values(cfg.items)) {
      if (item.auto) delete cfg.items[item.id];
    }
  }
  if (Object.keys(cfg.items).length >= MAX_BACKUPS) {
    throw new Error(`This server already has ${MAX_BACKUPS} backups. Delete one with \`/backup delete\` first.`);
  }

  const id = cfg.nextId;
  cfg.nextId += 1;
  cfg.items[id] = {
    id,
    name,
    auto,
    createdAt: Date.now(),
    createdBy,
    roles: guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id).map(snapshotRole),
    channels: guild.channels.cache.filter((c) => RESTORABLE_TYPES.has(c.type)).map(snapshotChannel),
  };
  store.save();
  return cfg.items[id];
}

function autoBackupEnabled(guildId) {
  const guild = store.guild(guildId);
  return guild.autoBackup !== false;
}

function setAutoBackup(guildId, enabled) {
  const guild = store.guild(guildId);
  guild.autoBackup = enabled;
  store.save();
  return enabled;
}

// Daily structural snapshot per guild. It replaces the previous automatic backup and never
// touches user-created ones. A full backup list simply skips that day.
function runAutoBackups(client) {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    try {
      const record = store.guild(guild.id);
      if (record.autoBackup === false) continue;
      if (now - (record.lastAutoBackupAt ?? 0) < AUTO_EVERY_MS) continue;
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) continue;
      createBackup(guild, 'Automatic backup', client.user.id, { auto: true });
      record.lastAutoBackupAt = now;
      store.save();
    } catch (err) {
      if (!/already has/.test(err.message)) {
        console.error(`Automatic backup failed for ${guild.name}:`, err.message);
      }
    }
  }
}

function startScheduler(client) {
  const run = () => runAutoBackups(client);
  run();
  setInterval(run, 60 * 60 * 1000);
}

// Recreates roles and channels that are missing. An item counts as present when a role with the same name
// exists, or a channel with the same name and type. Nothing is deleted, so running a restore twice is safe.
async function restoreBackup(guild, backup) {
  const report = { roles: 0, channels: 0, skipped: 0, failed: 0 };
  const roleMap = new Map([[guild.id, guild.id]]);
  const roleByName = new Map([...guild.roles.cache.values()].map((r) => [r.name, r.id]));

  // Roles first, so overwrites can point at them.
  for (const saved of [...backup.roles].sort((a, b) => a.position - b.position)) {
    if (roleByName.has(saved.name)) {
      roleMap.set(saved.id, roleByName.get(saved.name));
      report.skipped += 1;
      continue;
    }
    try {
      const created = await guild.roles.create({
        name: saved.name,
        color: saved.color,
        hoist: saved.hoist,
        mentionable: saved.mentionable,
        permissions: BigInt(saved.permissions),
        reason: `Backup #${backup.id} restore`,
      });
      roleMap.set(saved.id, created.id);
      roleByName.set(saved.name, created.id);
      report.roles += 1;
    } catch {
      report.failed += 1;
    }
  }

  const channelKey = (name, type) => `${type}:${name}`;
  const channelByKey = new Map([...guild.channels.cache.values()].map((c) => [channelKey(c.name, c.type), c.id]));
  const channelMap = new Map();

  // Categories come first, so the channels inside them can be attached to their parent.
  const isCategory = (c) => c.type === ChannelType.GuildCategory;
  const ordered = [...backup.channels].sort((a, b) => isCategory(b) - isCategory(a) || a.position - b.position);

  for (const saved of ordered) {
    const existing = channelByKey.get(channelKey(saved.name, saved.type));
    if (existing) {
      channelMap.set(saved.id, existing);
      report.skipped += 1;
      continue;
    }
    // Member overwrites are left out: the member may no longer be in the server, which would reject the channel.
    const overwrites = saved.overwrites
      .filter((o) => o.type === 0 && roleMap.has(o.id))
      .map((o) => ({ id: roleMap.get(o.id), type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
    try {
      const created = await guild.channels.create({
        name: saved.name,
        type: saved.type,
        parent: saved.type !== ChannelType.GuildCategory && saved.parentId ? channelMap.get(saved.parentId) ?? null : null,
        topic: saved.topic ?? undefined,
        nsfw: saved.nsfw,
        rateLimitPerUser: saved.rateLimitPerUser,
        bitrate: saved.bitrate ?? undefined,
        userLimit: saved.userLimit ?? undefined,
        permissionOverwrites: overwrites,
        reason: `Backup #${backup.id} restore`,
      });
      channelMap.set(saved.id, created.id);
      channelByKey.set(channelKey(saved.name, saved.type), created.id);
      report.channels += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}

function listBackups(guildId) {
  return Object.values(backupsOf(guildId).items).sort((a, b) => a.id - b.id);
}

function findBackup(guildId, id) {
  return backupsOf(guildId).items[id] ?? null;
}

function deleteBackup(guildId, id) {
  const cfg = backupsOf(guildId);
  if (!cfg.items[id]) return false;
  delete cfg.items[id];
  store.save();
  return true;
}

module.exports = {
  createBackup,
  restoreBackup,
  listBackups,
  findBackup,
  deleteBackup,
  autoBackupEnabled,
  setAutoBackup,
  runAutoBackups,
  startScheduler,
  MAX_BACKUPS,
  AUTO_EVERY_MS,
};
