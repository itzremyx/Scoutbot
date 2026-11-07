const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { fail, hasPerm, makeEmbed, sendLog } = require('../utils');
const { addModlogEntry } = require('../modlog');

const MAX_PURGE = 100;
const SLOWMODE_MAX = 21600; // Discord's limit: 6 hours

// Parse duration strings like "30m", "1h", "2d", "1h30m" into milliseconds.
// Returns null if invalid.
function parseDuration(str) {
  if (!str) return null;
  const match = str.trim().toLowerCase().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return null;
  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseInt(match[4] || '0', 10);
  if (days === 0 && hours === 0 && minutes === 0 && seconds === 0) return null;
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000;
}

function formatDuration(ms) {
  if (!ms) return 'unknown';
  const s = Math.floor(ms / 1000);
  const parts = [];
  if (s >= 86400) { parts.push(`${Math.floor(s / 86400)}d`); s %= 86400; }
  if (s >= 3600) { parts.push(`${Math.floor(s / 3600)}h`); s %= 3600; }
  if (s >= 60) { parts.push(`${Math.floor(s / 60)}m`); s %= 60; }
  if (s > 0) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

const logAction = (interaction, title, detail) =>
  sendLog(interaction.guild, {
    embeds: [makeEmbed('info', title, `${detail}\n**Channel:** ${interaction.channel}\n**Moderator:** <@${interaction.user.id}>`)],
  });

const purge = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete recent messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option.setName('amount').setDescription('How many messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(MAX_PURGE),
    )
    .addUserOption((option) => option.setName('user').setDescription('Only delete messages from this user')),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageMessages)) {
      return fail(interaction, 'You need the Manage Messages permission to do this.');
    }

    const amount = interaction.options.getInteger('amount', true);
    const user = interaction.options.getUser('user');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // bulkDelete ignores messages older than 14 days, and only deletes what it fetched.
    const fetched = await interaction.channel.messages.fetch({ limit: MAX_PURGE });
    const targets = [...fetched.values()]
      .filter((message) => !user || message.author.id === user.id)
      .slice(0, amount);

    if (!targets.length) {
      return interaction.editReply({ embeds: [makeEmbed('info', 'Nothing to delete', 'No matching messages were found in the last 100 messages.')] });
    }

    const deleted = await interaction.channel.bulkDelete(targets, true);
    addModlogEntry(interaction.guild.id, {
      userId: interaction.user.id,
      action: 'purge',
      reason: `${deleted.size} message(s) in ${interaction.channel}${user ? ` (only <@${user.id}>)` : ''}`,
      moderatorId: interaction.user.id,
      meta: { channel: interaction.channelId },
    });
    await logAction(interaction, 'Messages purged', `**Deleted:** ${deleted.size}${user ? `\n**Only from:** <@${user.id}>` : ''}`);
    return interaction.editReply({
      embeds: [makeEmbed('success', 'Purge complete', `Deleted ${deleted.size} message(s). Messages older than 14 days cannot be bulk-deleted.`)],
    });
  },
};

const purgeUserTime = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('purge-user-time')
    .setDescription('Delete messages from a specific user within a time window (e.g., 30m, 1h, 2d)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addUserOption((option) =>
      option.setName('user').setDescription('User whose messages to delete').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('Time window to look back (e.g., 30m, 1h, 2d, 1h30m)')
        .setRequired(true)
        .setMaxLength(20),
    )
    .addIntegerOption((option) =>
      option.setName('limit').setDescription('Maximum messages to scan (default 100, max 100)').setMinValue(1).setMaxValue(MAX_PURGE),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageMessages)) {
      return fail(interaction, 'You need the Manage Messages permission to do this.');
    }

    const user = interaction.options.getUser('user', true);
    const durationStr = interaction.options.getString('duration', true);
    const limit = interaction.options.getInteger('limit') ?? MAX_PURGE;

    const windowMs = parseDuration(durationStr);
    if (!windowMs) {
      return fail(interaction, 'Invalid duration format. Use formats like: 30m, 1h, 2d, 1h30m, 45s');
    }

    // Discord limits bulk delete to messages < 14 days old
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    if (windowMs > fourteenDaysMs) {
      return fail(interaction, `Time window cannot exceed 14 days (Discord limitation).`);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cutoff = Date.now() - windowMs;
    const fetched = await interaction.channel.messages.fetch({ limit });
    const targets = [...fetched.values()]
      .filter((message) => message.author.id === user.id && message.createdTimestamp >= cutoff)
      .slice(0, limit);

    if (!targets.length) {
      return interaction.editReply({
        embeds: [makeEmbed('info', 'Nothing to delete', `No messages from <@${user.id}> found in the last ${formatDuration(windowMs)}.`)],
      });
    }

    const deleted = await interaction.channel.bulkDelete(targets, true);
    addModlogEntry(interaction.guild.id, {
      userId: interaction.user.id,
      action: 'purge',
      reason: `${deleted.size} message(s) from <@${user.id}> in ${interaction.channel} (last ${formatDuration(windowMs)})`,
      moderatorId: interaction.user.id,
      meta: { channel: interaction.channelId, targetUser: user.id, duration: windowMs },
    });
    await logAction(interaction, 'Messages purged', `**Deleted:** ${deleted.size}\n**From:** <@${user.id}>\n**Time window:** ${formatDuration(windowMs)}`);
    return interaction.editReply({
      embeds: [makeEmbed('success', 'Purge complete', `Deleted ${deleted.size} message(s) from <@${user.id}> in the last ${formatDuration(windowMs)}. Messages older than 14 days cannot be bulk-deleted.`)],
    });
  },
};

const slowmode = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set the slowmode delay for this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) =>
      option
        .setName('seconds')
        .setDescription('Delay between messages (0 turns it off, max 21600)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(SLOWMODE_MAX),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageChannels)) {
      return fail(interaction, 'You need the Manage Channels permission to do this.');
    }

    const seconds = interaction.options.getInteger('seconds', true);
    await interaction.channel.setRateLimitPerUser(seconds, `Slowmode set by ${interaction.user.username}`);
    await logAction(interaction, 'Slowmode changed', `**Delay:** ${seconds === 0 ? 'off' : `${seconds}s`}`);
    return interaction.reply({
      embeds: [makeEmbed('success', 'Slowmode updated', seconds === 0 ? 'Slowmode is off.' : `Members can send one message every ${seconds}s.`)],
    });
  },
};

// Lock and unlock change SendMessages for @everyone. Other overwrites (staff, tickets) are left alone.
async function setLocked(interaction, locked) {
  if (!hasPerm(interaction, PermissionFlagsBits.ManageChannels)) {
    return fail(interaction, 'You need the Manage Channels permission to do this.');
  }

  const everyone = interaction.guild.roles.everyone;
  const reason = `${locked ? 'Locked' : 'Unlocked'} by ${interaction.user.username}`;
  await interaction.channel.permissionOverwrites.edit(everyone, { SendMessages: locked ? false : null }, { reason });
  await logAction(interaction, locked ? 'Channel locked' : 'Channel unlocked', `**Action:** ${locked ? 'locked' : 'unlocked'}`);

  return interaction.reply({
    embeds: [
      makeEmbed(
        locked ? 'warn' : 'success',
        locked ? '🔒 Channel locked' : '🔓 Channel unlocked',
        locked ? 'Members can no longer send messages here.' : 'Members can send messages here again.',
      ),
    ],
  });
}

const lock = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Stop everyone from sending messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  execute: (interaction) => setLocked(interaction, true),
};

const unlock = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Let everyone send messages in this channel again')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  execute: (interaction) => setLocked(interaction, false),
};

module.exports = { purge, purgeUserTime, slowmode, lock, unlock };
