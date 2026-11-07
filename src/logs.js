const {
  AttachmentBuilder,
  AuditLogEvent,
  AutoModerationActionType,
  AutoModerationRuleTriggerType,
  ChannelType,
  Events,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildScheduledEventStatus,
  GuildVerificationLevel,
  OverwriteType,
  PermissionFlagsBits,
} = require('discord.js');
const store = require('./storage');
const { makeEmbed, sendLog, truncate } = require('./utils');

// Log categories a server can switch off with /logs toggle.
const CATEGORIES = {
  messages: 'Messages',
  members: 'Members',
  roles: 'Roles',
  channels: 'Channels',
  threads: 'Threads',
  voice: 'Voice',
  server: 'Server',
  webhooks: 'Webhooks',
  invites: 'Invites',
  emojis: 'Emojis & stickers',
  events: 'Scheduled events',
  automod: 'AutoMod',
  stickies: 'Sticky messages',
};

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PERMISSION_NAMES = Object.keys(PermissionFlagsBits);
const STATE_LABEL = { allow: '✅ Allow', deny: '⛔ Deny', neutral: '➖ Neutral' };

// Per-guild log settings live on the guild record in store.json.
function logConfig(guildId) {
  const guild = store.guild(guildId);
  guild.logDisabled ??= [];
  guild.logIgnored ??= [];
  return guild;
}

function shouldLog(guild, category, channelId = null) {
  const config = logConfig(guild.id);
  if (!config.logChannelId || config.logDisabled.includes(category)) return false;
  // Nothing from the log channel itself or from ignored channels is logged.
  if (channelId && (channelId === config.logChannelId || config.logIgnored.includes(channelId))) return false;
  return true;
}

const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

// Discord only sends the author and content of a message it has cached, so an uncached deletion
// arrives as a partial with no author or text. This remembers recent messages from the channels we
// log (oldest dropped first) so deletions and edits can still be described. Like Discord's own
// message cache it lives in memory only: a restart clears it.
const recentMessages = new Map();
const RECENT_CAP = 5000;

function remember(message) {
  if (!message?.guild || !message.author) return;
  if (!shouldLog(message.guild, 'messages', message.channelId)) return;
  recentMessages.delete(message.id); // re-insert so the oldest entries are the first dropped
  recentMessages.set(message.id, {
    author: message.author,
    content: message.content,
    createdTimestamp: message.createdTimestamp,
    attachments: message.attachments,
  });
  while (recentMessages.size > RECENT_CAP) recentMessages.delete(recentMessages.keys().next().value);
}

// Rows are [name, value, inline]. Rows with an empty value are skipped. A value of '-' prints
// an em dash: a field whose value is deliberately empty still needs its name to show up.
function logEmbed(kind, title, fields) {
  const embed = makeEmbed(kind, title);
  embed.addFields(
    fields
      .filter((row) => row && row[1] !== null && row[1] !== undefined && row[1] !== '')
      .map(([name, value, inline = false]) => ({
        name,
        value: value === '—' ? value : truncate(String(value), 1000),
        inline,
      })),
  );
  return embed;
}

const post = (guild, kind, title, fields) => sendLog(guild, { embeds: [logEmbed(kind, title, fields)] });

// Keeps only the change rows that actually have a value.
const changesOf = (...rows) => rows.filter(([, value]) => value !== null && value !== undefined && value !== '');

const show = (value) =>
  value === null || value === undefined || value === ''
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

// "old → new", or null when nothing changed.
const diff = (oldValue, newValue, fmt = show) => (oldValue === newValue ? null : `${fmt(oldValue)} → ${fmt(newValue)}`);

// Downloads images and GIFs into memory so the log embed can show them.
// They are never written to disk or saved in store.json: they only live in the log message.
async function captureAttachments(attachments) {
  const files = [];
  const links = [];
  let image = null;
  for (const att of attachments.values()) {
    const name = att.name ?? 'file';
    const isImage = att.contentType?.startsWith('image/') || IMAGE_EXT.test(name);
    if (!isImage || files.length >= MAX_IMAGES || att.size > MAX_FILE_BYTES) {
      links.push(`[${name}](${att.url})`);
      continue;
    }
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? `.${att.contentType?.split('/')[1] ?? 'png'}`).toLowerCase();
      const fileName = `image${files.length}${ext}`;
      files.push(new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: fileName }));
      image ??= fileName;
    } catch {
      // The CDN link may have expired after deletion. Keep the name so staff still see what was there.
      links.push(`[${name}](${att.url}) (could not be re-downloaded)`);
    }
  }
  return { files, links, image };
}

// Finds the audit log entry that explains a change. Discord writes it just before the event fires,
// so a short window is enough. Returns null when the bot cannot read the audit log or nothing matches.
async function findAudit(guild, actions, match = () => true, maxAge = 10_000) {
  const logs = await guild.fetchAuditLogs({ limit: 10 }).catch(() => null);
  if (!logs) return null;
  return (
    logs.entries.find((e) => actions.includes(e.action) && Date.now() - e.createdTimestamp < maxAge && match(e)) ?? null
  );
}

const byEntry = (entry) => (entry?.executor ? `${entry.executor}` : 'Unknown');

// Raw "key: old → new" lines from the audit log, for changes without a dedicated formatter.
function auditChanges(entry) {
  if (!entry?.changes?.length) return null;
  return entry.changes.slice(0, 10).map((c) => `\`${c.key}\`: ${show(c.old)} → ${show(c.new)}`).join('\n');
}

// Audit log is the only way to know who deleted a message. Needs the View Audit Log permission.
// authorId comes from the message or from the recent-message cache, so the right entry is found
// even when the deletion event itself arrived as a partial.
async function deletedBy(message, authorId) {
  const logs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 }).catch(() => null);
  if (!logs) return 'Unknown (no audit log access)';
  const entry = logs.entries.find(
    (e) =>
      e.extra?.channel?.id === message.channelId &&
      Date.now() - e.createdTimestamp < 15_000 &&
      (!authorId || e.target?.id === authorId),
  );
  if (!entry) return authorId ? 'Unknown (no matching audit entry)' : 'Unknown';
  if (entry.executor && entry.executor.id !== authorId) return `${entry.executor}`;
  return authorId ? 'Author (no moderator action found)' : 'Unknown';
}

// Permission state of one flag inside an overwrite: allow, deny or neutral (not set).
const stateOf = (overwrite, name) =>
  overwrite?.allow.has(name) ? 'allow' : overwrite?.deny.has(name) ? 'deny' : 'neutral';

const targetOf = (guild, overwrite) =>
  overwrite.type === OverwriteType.Role
    ? (guild.roles.cache.get(overwrite.id)?.toString() ?? `Role ${overwrite.id}`)
    : `<@${overwrite.id}>`;

// Lists each role or member overwrite whose permissions changed, flag by flag.
function overwriteChanges(oldChannel, newChannel) {
  const before = oldChannel.permissionOverwrites.cache;
  const after = newChannel.permissionOverwrites.cache;
  const lines = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const o = before.get(id);
    const n = after.get(id);
    if (!o) {
      const set = PERMISSION_NAMES.filter((p) => stateOf(n, p) !== 'neutral').map((p) => `${p} ${STATE_LABEL[stateOf(n, p)]}`);
      lines.push(`**Added** ${targetOf(newChannel.guild, n)}: ${set.join(', ') || 'no permissions set'}`);
    } else if (!n) {
      lines.push(`**Removed** ${targetOf(newChannel.guild, o)}`);
    } else {
      const diffs = PERMISSION_NAMES.filter((p) => stateOf(o, p) !== stateOf(n, p)).map(
        (p) => `${p}: ${STATE_LABEL[stateOf(o, p)]} → ${STATE_LABEL[stateOf(n, p)]}`,
      );
      if (diffs.length) lines.push(`**Changed** ${targetOf(newChannel.guild, n)}\n${diffs.join('\n')}`);
    }
  }
  return lines.length ? lines.join('\n\n') : null;
}

const CHANNEL_ACTIONS = [
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
];

async function onMessageDelete(message) {
  if (!message.guild) return;
  const seen = recentMessages.get(message.id);
  const author = message.author ?? seen?.author; // partial events carry no author
  if (author?.bot) return;
  if (!shouldLog(message.guild, 'messages', message.channelId)) return;

  const content = message.content ?? seen?.content;
  const sentAt = message.createdTimestamp ?? seen?.createdTimestamp;
  const attachments = message.attachments?.size
    ? message.attachments
    : (seen?.attachments ?? message.attachments);

  const { files, links, image } = await captureAttachments(attachments);
  const embed = logEmbed('error', 'Message deleted', [
    ['Author', author ? `${author} (${author.tag})` : 'Unknown (not cached)', true],
    ['Channel', `<#${message.channelId}>`, true],
    ['Deleted by', await deletedBy(message, author?.id ?? null), true],
    ['Sent', sentAt ? ts(sentAt) : null, true],
    ['Content', content == null ? '(not cached)' : content || '(no text)'],
    links.length && ['Attachments', links.join('\n')],
  ]);
  if (image) embed.setImage(`attachment://${image}`);
  recentMessages.delete(message.id);
  await sendLog(message.guild, { embeds: [embed], files });
}

async function onMessageUpdate(oldMessage, newMessage) {
  if (!newMessage.guild) return;
  const seen = recentMessages.get(newMessage.id);
  const author = newMessage.author ?? seen?.author;
  if (author?.bot) return;
  // The old text may only exist in our own cache when either side is a partial.
  const before = oldMessage.content ?? seen?.content ?? null;
  const after = newMessage.content;
  if (before === null && after === null) return;
  if (before === after) return;
  if (!shouldLog(newMessage.guild, 'messages', newMessage.channelId)) return;
  remember(newMessage);

  const embed = logEmbed('warn', 'Message edited', [
    ['Author', author ? `${author} (${author.tag})` : 'Unknown', true],
    ['Channel', `<#${newMessage.channelId}>`, true],
    ['Before', before ?? '(not cached)'],
    ['After', after == null ? '(not cached)' : after || '(no text)'],
    ['Jump to message', `[Open message](${newMessage.url})`],
  ]);
  await sendLog(newMessage.guild, { embeds: [embed] });
}

async function onBulkDelete(messages, channel) {
  if (!channel.guild || !shouldLog(channel.guild, 'messages', channel.id)) return;

  const lines = [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author?.tag ?? 'unknown'}: ${m.content ?? '(not cached)'}`);
  const file = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: 'bulk-delete.txt' });
  const embed = logEmbed('error', 'Messages bulk deleted', [
    ['Channel', `<#${channel.id}>`, true],
    ['Count', String(messages.size), true],
    ['Preview', lines.slice(0, 10).join('\n')],
    ['Full list', 'Attached as bulk-delete.txt'],
  ]);
  await sendLog(channel.guild, { embeds: [embed], files: [file] });
}

async function onMemberAdd(member) {
  if (!shouldLog(member.guild, 'members')) return;
  await post(member.guild, 'success', 'Member joined', [
    ['Member', `${member} (${member.user.tag})`, true],
    ['ID', member.id, true],
    ['Account created', ts(member.user.createdTimestamp, 'R'), true],
    ['Member count', String(member.guild.memberCount), true],
  ]);
}

async function onMemberRemove(member) {
  if (!shouldLog(member.guild, 'members')) return;
  const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id);
  // A kick reaches the bot as a plain leave, so the audit log decides which one it was.
  const kick = await findAudit(member.guild, [AuditLogEvent.MemberKick], (e) => e.targetId === member.id);
  await post(member.guild, 'error', kick ? 'Member kicked' : 'Member left', [
    ['Member', `${member.user} (${member.user.tag})`, true],
    ['ID', member.id, true],
    ['Joined', member.joinedTimestamp ? ts(member.joinedTimestamp) : null, true],
    kick && ['Kicked by', byEntry(kick), true],
    kick && ['Reason', kick.reason],
    ['Roles', roles?.size ? [...roles.values()].join(' ') : null],
  ].filter(Boolean));
}

async function onMemberUpdate(oldMember, newMember) {
  if (!oldMember?.roles || !shouldLog(newMember.guild, 'members')) return;

  const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
  const timeoutUntil = newMember.communicationDisabledUntilTimestamp;
  const changes = changesOf(
    ['Nickname', diff(oldMember.nickname, newMember.nickname, (v) => v || '*none*')],
    ['Roles added', added.size ? [...added.values()].join(' ') : null],
    ['Roles removed', removed.size ? [...removed.values()].join(' ') : null],
    [
      'Timeout',
      oldMember.communicationDisabledUntilTimestamp === timeoutUntil
        ? null
        : timeoutUntil && timeoutUntil > Date.now()
          ? `Until ${ts(timeoutUntil)}`
          : 'Removed',
    ],
  );
  if (!changes.length) return;

  // Timeouts and role changes by moderators show up in the audit log, not in the member event.
  const entry = await findAudit(newMember.guild, [AuditLogEvent.MemberUpdate, AuditLogEvent.MemberRoleUpdate], (e) => e.targetId === newMember.id);
  await post(newMember.guild, 'info', 'Member updated', [
    ['Member', `${newMember} (${newMember.user.tag})`, true],
    ['Changed by', byEntry(entry), true],
    ...changes,
  ]);
}

async function onBanAdd(ban) {
  if (!shouldLog(ban.guild, 'members')) return;
  const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 }).catch(() => null);
  const entry = logs?.entries.first();
  await post(ban.guild, 'error', 'Member banned', [
    ['User', `${ban.user.tag}`, true],
    ['ID', ban.user.id, true],
    ['Moderator', entry?.target?.id === ban.user.id ? `${entry.executor}` : null, true],
    ['Reason', ban.reason || entry?.reason],
  ]);
}

async function onBanRemove(ban) {
  if (!shouldLog(ban.guild, 'members')) return;
  const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 1 }).catch(() => null);
  const entry = logs?.entries.first();
  await post(ban.guild, 'success', 'Member unbanned', [
    ['User', `${ban.user.tag}`, true],
    ['ID', ban.user.id, true],
    ['Moderator', entry?.target?.id === ban.user.id ? `${entry.executor}` : null, true],
  ]);
}

async function onRoleCreate(role) {
  if (!shouldLog(role.guild, 'roles')) return;
  const entry = await findAudit(role.guild, [AuditLogEvent.RoleCreate], (e) => e.targetId === role.id);
  await post(role.guild, 'success', 'Role created', [
    ['Role', `${role} (${role.name})`, true],
    ['ID', role.id, true],
    ['Color', role.hexColor, true],
    ['Created by', byEntry(entry), true],
  ]);
}

async function onRoleDelete(role) {
  if (!shouldLog(role.guild, 'roles')) return;
  const entry = await findAudit(role.guild, [AuditLogEvent.RoleDelete], (e) => e.targetId === role.id);
  await post(role.guild, 'error', 'Role deleted', [
    ['Role', role.name, true],
    ['ID', role.id, true],
    ['Color', role.hexColor, true],
    ['Deleted by', byEntry(entry), true],
  ]);
}

async function onRoleUpdate(oldRole, newRole) {
  if (!shouldLog(newRole.guild, 'roles')) return;

  // missing() lists permissions present in the argument but not in the receiver.
  const gained = oldRole.permissions.missing(newRole.permissions);
  const lost = newRole.permissions.missing(oldRole.permissions);
  const changes = changesOf(
    ['Name', diff(oldRole.name, newRole.name)],
    ['Color', diff(oldRole.hexColor, newRole.hexColor)],
    ['Shown separately', diff(oldRole.hoist, newRole.hoist, (v) => (v ? 'Yes' : 'No'))],
    ['Mentionable', diff(oldRole.mentionable, newRole.mentionable, (v) => (v ? 'Yes' : 'No'))],
    ['Permissions added', gained.length ? gained.join(', ') : null],
    ['Permissions removed', lost.length ? lost.join(', ') : null],
  );
  if (!changes.length) return;

  const entry = await findAudit(newRole.guild, [AuditLogEvent.RoleUpdate], (e) => e.targetId === newRole.id);
  await post(newRole.guild, 'info', 'Role updated', [
    ['Role', `${newRole} (${newRole.name})`, true],
    ['Changed by', byEntry(entry), true],
    ...changes,
  ]);
}

async function onChannelCreate(channel) {
  if (!channel.guild || !shouldLog(channel.guild, 'channels')) return;
  const entry = await findAudit(channel.guild, [AuditLogEvent.ChannelCreate], (e) => e.targetId === channel.id);
  await post(channel.guild, 'success', 'Channel created', [
    ['Channel', `<#${channel.id}> (${channel.name})`, true],
    ['Type', ChannelType[channel.type], true],
    ['Category', channel.parent?.name, true],
    ['ID', channel.id, true],
    ['Created by', byEntry(entry), true],
  ]);
}

async function onChannelDelete(channel) {
  if (!channel.guild || !shouldLog(channel.guild, 'channels')) return;
  const entry = await findAudit(channel.guild, [AuditLogEvent.ChannelDelete], (e) => e.targetId === channel.id);
  await post(channel.guild, 'error', 'Channel deleted', [
    ['Channel', `#${channel.name}`, true],
    ['Type', ChannelType[channel.type], true],
    ['Category', channel.parent?.name, true],
    ['ID', channel.id, true],
    ['Deleted by', byEntry(entry), true],
  ]);
}

async function onChannelUpdate(oldChannel, newChannel) {
  if (!newChannel.guild || !shouldLog(newChannel.guild, 'channels')) return;

  const changes = changesOf(
    ['Name', diff(oldChannel.name, newChannel.name)],
    ['Topic', diff(oldChannel.topic, newChannel.topic, (v) => v || '*none*')],
    ['NSFW', diff(oldChannel.nsfw, newChannel.nsfw, (v) => (v ? 'On' : 'Off'))],
    ['Slowmode', diff(oldChannel.rateLimitPerUser, newChannel.rateLimitPerUser, (v) => `${v ?? 0}s`)],
    ['Category', diff(oldChannel.parent?.name, newChannel.parent?.name, (v) => v || 'None')],
    ['Bitrate', diff(oldChannel.bitrate, newChannel.bitrate, (v) => (v ? `${v / 1000} kbps` : '—'))],
    ['User limit', diff(oldChannel.userLimit, newChannel.userLimit, (v) => (v ? String(v) : 'Unlimited'))],
    ['Permission overwrites', overwriteChanges(oldChannel, newChannel)],
  );
  if (!changes.length) return;

  const entry = await findAudit(newChannel.guild, CHANNEL_ACTIONS, (e) => e.targetId === newChannel.id);
  await post(newChannel.guild, 'info', 'Channel updated', [
    ['Channel', `<#${newChannel.id}>`, true],
    ['Changed by', byEntry(entry), true],
    ...changes,
  ]);
}

async function onThreadCreate(thread, newlyCreated) {
  // Threads that already existed show up again when the bot sees them, so only real creations are logged.
  if (!newlyCreated || !thread.guild || !shouldLog(thread.guild, 'threads')) return;
  await post(thread.guild, 'success', 'Thread created', [
    ['Thread', `<#${thread.id}> (${thread.name})`, true],
    ['Parent', thread.parentId ? `<#${thread.parentId}>` : null, true],
    ['Owner', thread.ownerId ? `<@${thread.ownerId}>` : null, true],
  ]);
}

async function onThreadDelete(thread) {
  if (!thread.guild || !shouldLog(thread.guild, 'threads')) return;
  await post(thread.guild, 'error', 'Thread deleted', [
    ['Thread', thread.name, true],
    ['Parent', thread.parentId ? `<#${thread.parentId}>` : null, true],
    ['ID', thread.id, true],
  ]);
}

async function onThreadUpdate(oldThread, newThread) {
  if (!newThread.guild || !shouldLog(newThread.guild, 'threads')) return;
  const changes = changesOf(
    ['Name', diff(oldThread.name, newThread.name)],
    ['Locked', diff(oldThread.locked, newThread.locked, (v) => (v ? 'Yes' : 'No'))],
    ['Slowmode', diff(oldThread.rateLimitPerUser, newThread.rateLimitPerUser, (v) => `${v ?? 0}s`)],
  );
  if (!changes.length) return;
  await post(newThread.guild, 'info', 'Thread updated', [['Thread', `<#${newThread.id}>`, true], ...changes]);
}

async function onVoiceState(oldState, newState) {
  const member = newState.member;
  if (!member || member.user.bot) return;
  if (!shouldLog(newState.guild, 'voice')) return;

  // Server mute and deafen keep the same channel, so they are checked before the channel comparison.
  if (oldState.channelId === newState.channelId) {
    const changes = changesOf(
      ['Server mute', diff(oldState.serverMute, newState.serverMute, (v) => (v ? 'On' : 'Off'))],
      ['Server deafen', diff(oldState.serverDeaf, newState.serverDeaf, (v) => (v ? 'On' : 'Off'))],
    );
    if (!changes.length) return;
    const entry = await findAudit(newState.guild, [AuditLogEvent.MemberUpdate], (e) => e.targetId === member.id);
    await post(newState.guild, 'info', 'Voice moderation', [
      ['Member', `${member} (${member.user.tag})`, true],
      ['Channel', `<#${newState.channelId}>`, true],
      ['Changed by', byEntry(entry), true],
      ...changes,
    ]);
    return;
  }

  let kind = 'success';
  let action = 'joined';
  let where = `<#${newState.channelId}>`;
  if (oldState.channelId && !newState.channelId) {
    kind = 'error';
    action = 'left';
    where = `<#${oldState.channelId}>`;
  } else if (oldState.channelId) {
    kind = 'info';
    action = 'moved';
    where = `<#${oldState.channelId}> → <#${newState.channelId}>`;
  }

  await post(newState.guild, kind, `Voice ${action}`, [
    ['Member', `${member} (${member.user.tag})`, true],
    ['Channel', where, true],
  ]);
}

async function onServerUpdate(oldGuild, newGuild) {
  if (!shouldLog(newGuild, 'server')) return;
  const changes = changesOf(
    ['Name', diff(oldGuild.name, newGuild.name)],
    ['Verification level', diff(oldGuild.verificationLevel, newGuild.verificationLevel, (v) => GuildVerificationLevel[v] ?? v)],
    ['Explicit content filter', diff(oldGuild.explicitContentFilter, newGuild.explicitContentFilter, (v) => GuildExplicitContentFilter[v] ?? v)],
    ['Default notifications', diff(oldGuild.defaultMessageNotifications, newGuild.defaultMessageNotifications, (v) => GuildDefaultMessageNotifications[v] ?? v)],
    ['AFK timeout', diff(oldGuild.afkTimeout, newGuild.afkTimeout, (v) => `${v / 60} min`)],
    ['Vanity URL', diff(oldGuild.vanityURLCode, newGuild.vanityURLCode, (v) => (v ? `discord.gg/${v}` : 'None'))],
    ['Icon', oldGuild.icon === newGuild.icon ? null : 'Changed'],
  );
  if (!changes.length) return;

  const entry = await findAudit(newGuild, [AuditLogEvent.GuildUpdate], (e) => e.targetId === newGuild.id);
  await post(newGuild, 'info', 'Server updated', [['Changed by', byEntry(entry), true], ...changes]);
}

async function onWebhooksUpdate(channel) {
  if (!channel.guild || !shouldLog(channel.guild, 'webhooks', channel.id)) return;

  const WEBHOOK_ACTIONS = [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete];
  const logs = await channel.guild.fetchAuditLogs({ limit: 10 }).catch(() => null);
  if (!logs) {
    return post(channel.guild, 'info', 'Webhooks changed', [
      ['Channel', `<#${channel.id}>`, true],
      ['Details', 'Unknown (no audit log access)'],
    ]);
  }

  // The same audit entry can arrive with several webhook events, so each one is logged once.
  const recent = logs.entries.filter(
    (e) => WEBHOOK_ACTIONS.includes(e.action) && Date.now() - e.createdTimestamp < 15_000 && markSeen(e.id),
  );
  for (const e of recent.values()) {
    const created = e.action === AuditLogEvent.WebhookCreate;
    const deleted = e.action === AuditLogEvent.WebhookDelete;
    const name = e.changes?.find((c) => c.key === 'name');
    await post(channel.guild, created ? 'success' : deleted ? 'error' : 'info', `Webhook ${created ? 'created' : deleted ? 'deleted' : 'updated'}`, [
      ['Webhook', name?.new ?? name?.old ?? `ID ${e.targetId}`, true],
      ['Channel', `<#${channel.id}>`, true],
      ['Moderator', byEntry(e), true],
      ['Changes', auditChanges(e)],
    ]);
  }
}

// Remembers recent audit entry ids so a webhook change is never logged twice. Returns true the first time.
const seenAudit = new Set();
function markSeen(id) {
  if (seenAudit.has(id)) return false;
  seenAudit.add(id);
  if (seenAudit.size > 500) seenAudit.delete(seenAudit.values().next().value);
  return true;
}

async function onInviteCreate(invite) {
  const guild = invite.guild;
  // Invites from guilds the bot cannot fully see come with a partial guild object, which cannot send logs.
  if (!guild?.channels || !shouldLog(guild, 'invites')) return;
  await post(guild, 'success', 'Invite created', [
    ['Code', invite.code, true],
    ['Channel', invite.channelId ? `<#${invite.channelId}>` : null, true],
    ['Created by', invite.inviter ? `${invite.inviter} (${invite.inviter.tag})` : null, true],
    ['Max uses', invite.maxUses ? String(invite.maxUses) : 'Unlimited', true],
    ['Expires', invite.maxAge ? `In ${Math.round(invite.maxAge / 60)} min` : 'Never', true],
    ['Temporary', invite.temporary ? 'Yes' : 'No', true],
    ['URL', invite.url],
  ]);
}

async function onInviteDelete(invite) {
  const guild = invite.guild;
  if (!guild?.channels || !shouldLog(guild, 'invites')) return;
  const entry = await findAudit(guild, [AuditLogEvent.InviteDelete], (e) => e.changes?.some((c) => c.key === 'code' && c.old === invite.code));
  await post(guild, 'error', 'Invite deleted', [
    ['Code', invite.code, true],
    ['Channel', invite.channelId ? `<#${invite.channelId}>` : null, true],
    ['Deleted by', byEntry(entry), true],
  ]);
}

async function onEmojiCreate(emoji) {
  if (!shouldLog(emoji.guild, 'emojis')) return;
  const entry = await findAudit(emoji.guild, [AuditLogEvent.EmojiCreate], (e) => e.targetId === emoji.id);
  await post(emoji.guild, 'success', 'Emoji added', [
    ['Emoji', `${emoji} :${emoji.name}:`, true],
    ['ID', emoji.id, true],
    ['Animated', emoji.animated ? 'Yes' : 'No', true],
    ['Added by', byEntry(entry), true],
  ]);
}

async function onEmojiUpdate(oldEmoji, newEmoji) {
  if (!shouldLog(newEmoji.guild, 'emojis')) return;
  const changes = changesOf(['Name', diff(oldEmoji.name, newEmoji.name)]);
  if (!changes.length) return;
  const entry = await findAudit(newEmoji.guild, [AuditLogEvent.EmojiUpdate], (e) => e.targetId === newEmoji.id);
  await post(newEmoji.guild, 'info', 'Emoji updated', [['Emoji', `${newEmoji}`, true], ['Changed by', byEntry(entry), true], ...changes]);
}

async function onEmojiDelete(emoji) {
  if (!shouldLog(emoji.guild, 'emojis')) return;
  const entry = await findAudit(emoji.guild, [AuditLogEvent.EmojiDelete], (e) => e.targetId === emoji.id);
  await post(emoji.guild, 'error', 'Emoji deleted', [
    ['Name', `:${emoji.name}:`, true],
    ['ID', emoji.id, true],
    ['Deleted by', byEntry(entry), true],
  ]);
}

async function onStickerCreate(sticker) {
  if (!sticker.guild || !shouldLog(sticker.guild, 'emojis')) return;
  const entry = await findAudit(sticker.guild, [AuditLogEvent.StickerCreate], (e) => e.targetId === sticker.id);
  await post(sticker.guild, 'success', 'Sticker added', [
    ['Name', sticker.name, true],
    ['ID', sticker.id, true],
    ['Tags', sticker.tags, true],
    ['Added by', byEntry(entry), true],
  ]);
}

async function onStickerUpdate(oldSticker, newSticker) {
  if (!newSticker.guild || !shouldLog(newSticker.guild, 'emojis')) return;
  const changes = changesOf(
    ['Name', diff(oldSticker.name, newSticker.name)],
    ['Description', diff(oldSticker.description, newSticker.description, (v) => v || '*none*')],
    ['Tags', diff(oldSticker.tags, newSticker.tags, (v) => v || '*none*')],
  );
  if (!changes.length) return;
  const entry = await findAudit(newSticker.guild, [AuditLogEvent.StickerUpdate], (e) => e.targetId === newSticker.id);
  await post(newSticker.guild, 'info', 'Sticker updated', [['Sticker', newSticker.name, true], ['Changed by', byEntry(entry), true], ...changes]);
}

async function onStickerDelete(sticker) {
  if (!sticker.guild || !shouldLog(sticker.guild, 'emojis')) return;
  const entry = await findAudit(sticker.guild, [AuditLogEvent.StickerDelete], (e) => e.targetId === sticker.id);
  await post(sticker.guild, 'error', 'Sticker deleted', [
    ['Name', sticker.name, true],
    ['ID', sticker.id, true],
    ['Deleted by', byEntry(entry), true],
  ]);
}

async function onScheduledEventCreate(event) {
  if (!event.guild || !shouldLog(event.guild, 'events')) return;
  await post(event.guild, 'success', 'Scheduled event created', [
    ['Event', event.name, true],
    ['Starts', event.scheduledStartTimestamp ? ts(event.scheduledStartTimestamp) : null, true],
    ['ID', event.id, true],
  ]);
}

async function onScheduledEventUpdate(oldEvent, newEvent) {
  if (!newEvent.guild || !shouldLog(newEvent.guild, 'events')) return;
  const changes = changesOf(
    ['Name', diff(oldEvent?.name, newEvent.name)],
    ['Status', diff(oldEvent?.status, newEvent.status, (v) => GuildScheduledEventStatus[v] ?? '—')],
    ['Start time', diff(oldEvent?.scheduledStartTimestamp, newEvent.scheduledStartTimestamp, (v) => (v ? ts(v) : '—'))],
  );
  if (!changes.length) return;
  await post(newEvent.guild, 'info', 'Scheduled event updated', [['Event', newEvent.name, true], ...changes]);
}

async function onScheduledEventDelete(event) {
  if (!event.guild || !shouldLog(event.guild, 'events')) return;
  await post(event.guild, 'error', 'Scheduled event deleted', [
    ['Event', event.name, true],
    ['ID', event.id, true],
  ]);
}

const triggerName = (type) => AutoModerationRuleTriggerType[type] ?? type;

async function onAutoModRuleCreate(rule) {
  if (!shouldLog(rule.guild, 'automod')) return;
  const entry = await findAudit(rule.guild, [AuditLogEvent.AutoModerationRuleCreate], (e) => e.targetId === rule.id);
  await post(rule.guild, 'success', 'AutoMod rule created', [
    ['Rule', rule.name, true],
    ['Trigger', triggerName(rule.triggerType), true],
    ['Enabled', rule.enabled ? 'Yes' : 'No', true],
    ['Created by', byEntry(entry), true],
  ]);
}

async function onAutoModRuleUpdate(oldRule, newRule) {
  if (!newRule.guild || !shouldLog(newRule.guild, 'automod')) return;
  const changes = changesOf(
    ['Name', diff(oldRule?.name, newRule.name)],
    ['Enabled', diff(oldRule?.enabled, newRule.enabled, (v) => (v ? 'Yes' : 'No'))],
    ['Trigger', diff(oldRule?.triggerType, newRule.triggerType, triggerName)],
  );
  if (!changes.length) return;
  const entry = await findAudit(newRule.guild, [AuditLogEvent.AutoModerationRuleUpdate], (e) => e.targetId === newRule.id);
  await post(newRule.guild, 'info', 'AutoMod rule updated', [['Rule', newRule.name, true], ['Changed by', byEntry(entry), true], ...changes]);
}

async function onAutoModRuleDelete(rule) {
  if (!rule.guild || !shouldLog(rule.guild, 'automod')) return;
  const entry = await findAudit(rule.guild, [AuditLogEvent.AutoModerationRuleDelete], (e) => e.targetId === rule.id);
  await post(rule.guild, 'error', 'AutoMod rule deleted', [
    ['Rule', rule.name, true],
    ['Deleted by', byEntry(entry), true],
  ]);
}

// Fires when AutoMod blocks, flags or times out a message.
async function onAutoModAction(execution) {
  const guild = execution.guild;
  if (!guild || !shouldLog(guild, 'automod', execution.channelId)) return;
  await post(guild, 'warn', 'AutoMod triggered', [
    ['Rule', execution.autoModerationRule?.name ?? `ID ${execution.ruleId}`, true],
    ['Action', AutoModerationActionType[execution.action.type] ?? execution.action.type, true],
    ['User', execution.user ? `${execution.user} (${execution.user.tag})` : `<@${execution.userId}>`, true],
    ['Channel', execution.channelId ? `<#${execution.channelId}>` : null, true],
    ['Matched', execution.matchedKeyword, true],
    ['Content', execution.content],
  ]);
}

// A failing handler must not crash the bot, so errors are only printed.
const safe = (handler) => (...args) => handler(...args).catch((err) => console.error('Log error:', err));

function register(client) {
  // Warms the local message cache so an uncached deletion can still be described.
  client.on(Events.MessageCreate, (message) => remember(message));
  client.on(Events.MessageDelete, safe(onMessageDelete));
  client.on(Events.MessageUpdate, safe(onMessageUpdate));
  client.on(Events.MessageBulkDelete, safe(onBulkDelete));
  client.on(Events.GuildMemberAdd, safe(onMemberAdd));
  client.on(Events.GuildMemberRemove, safe(onMemberRemove));
  client.on(Events.GuildMemberUpdate, safe(onMemberUpdate));
  client.on(Events.GuildBanAdd, safe(onBanAdd));
  client.on(Events.GuildBanRemove, safe(onBanRemove));
  client.on(Events.GuildRoleCreate, safe(onRoleCreate));
  client.on(Events.GuildRoleDelete, safe(onRoleDelete));
  client.on(Events.GuildRoleUpdate, safe(onRoleUpdate));
  client.on(Events.ChannelCreate, safe(onChannelCreate));
  client.on(Events.ChannelDelete, safe(onChannelDelete));
  client.on(Events.ChannelUpdate, safe(onChannelUpdate));
  client.on(Events.ThreadCreate, safe(onThreadCreate));
  client.on(Events.ThreadDelete, safe(onThreadDelete));
  client.on(Events.ThreadUpdate, safe(onThreadUpdate));
  client.on(Events.VoiceStateUpdate, safe(onVoiceState));
  client.on(Events.GuildUpdate, safe(onServerUpdate));
  client.on(Events.WebhooksUpdate, safe(onWebhooksUpdate));
  client.on(Events.InviteCreate, safe(onInviteCreate));
  client.on(Events.InviteDelete, safe(onInviteDelete));
  client.on(Events.GuildEmojiCreate, safe(onEmojiCreate));
  client.on(Events.GuildEmojiUpdate, safe(onEmojiUpdate));
  client.on(Events.GuildEmojiDelete, safe(onEmojiDelete));
  client.on(Events.GuildStickerCreate, safe(onStickerCreate));
  client.on(Events.GuildStickerUpdate, safe(onStickerUpdate));
  client.on(Events.GuildStickerDelete, safe(onStickerDelete));
  client.on(Events.GuildScheduledEventCreate, safe(onScheduledEventCreate));
  client.on(Events.GuildScheduledEventUpdate, safe(onScheduledEventUpdate));
  client.on(Events.GuildScheduledEventDelete, safe(onScheduledEventDelete));
  client.on(Events.AutoModerationRuleCreate, safe(onAutoModRuleCreate));
  client.on(Events.AutoModerationRuleUpdate, safe(onAutoModRuleUpdate));
  client.on(Events.AutoModerationRuleDelete, safe(onAutoModRuleDelete));
  client.on(Events.AutoModerationActionExecution, safe(onAutoModAction));
}

module.exports = { register, CATEGORIES, logConfig, post, shouldLog };
