const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { fail, hasPerm, makeEmbed, sendLog } = require('../utils');
const { addModlogEntry } = require('../modlog');

const MAX_PURGE = 100;
const SLOWMODE_MAX = 21600; // Discord's limit: 6 hours

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

module.exports = { purge, slowmode, lock, unlock };
