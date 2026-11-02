const {
  MessageFlags,
  ActionRowBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { checkTarget, dmUser, fail, fetchMember, hasPerm, makeEmbed, sendLog, truncate } = require('../utils');

const DAY_MS = 86_400_000;
const MAX_TIMEOUT_MS = 28 * DAY_MS; // Discord's limit
const TIMEOUT_UNITS = { minutes: 60_000, hours: 3_600_000, days: DAY_MS };
const DEFAULT_REASON = 'No reason provided';

// Returns the member if the moderator may act on them, otherwise replies with the error and returns null.
async function getModeratableMember(interaction, user) {
  const member = await fetchMember(interaction.guild, user.id);
  if (!member) {
    await fail(interaction, 'That user is not a member of this server.');
    return null;
  }

  const error = await checkTarget(interaction.guild, interaction.user.id, member);
  if (error) {
    await fail(interaction, error);
    return null;
  }
  return member;
}

function logModeration(interaction, title, userId, reason, extra = '') {
  return sendLog(interaction.guild, {
    embeds: [
      makeEmbed(
        'warn',
        title,
        `**Member:** <@${userId}> (${userId})\n**Moderator:** <@${interaction.user.id}>\n**Reason:** ${reason}${extra}`,
      ),
    ],
  });
}

async function handleUnbanSelect(interaction) {
  if (!hasPerm(interaction, PermissionFlagsBits.BanMembers)) {
    return interaction.reply({ content: 'You need the Ban Members permission to do this.', flags: MessageFlags.Ephemeral });
  }

  const userId = interaction.values[0];
  await interaction.guild.bans.remove(userId, `Unbanned by ${interaction.user.username}`);
  await logModeration(interaction, 'Member unbanned', userId, 'Unbanned from the ban list');
  return interaction.update({ content: `✅ Unbanned <@${userId}>.`, components: [] });
}

module.exports = {
  guildOnly: true,
  handleUnbanSelect,

  kick: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member from the server')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to kick').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500)),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.KickMembers)) {
        return fail(interaction, 'You need the Kick Members permission to do this.');
      }

      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? DEFAULT_REASON;
      const member = await getModeratableMember(interaction, user);
      if (!member) return;

      await dmUser(user, makeEmbed('error', `You were kicked from ${interaction.guild.name}`, `**Reason:** ${reason}`));
      await member.kick(`${reason} (by ${interaction.user.username})`);
      await logModeration(interaction, 'Member kicked', user.id, reason);
      return interaction.reply({
        embeds: [makeEmbed('success', 'Member kicked', `<@${user.id}> was kicked.\n**Reason:** ${reason}`)],
      });
    },
  },

  ban: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user from the server')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((option) => option.setName('user').setDescription('User to ban').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500))
      .addIntegerOption((option) =>
        option
          .setName('delete_days')
          .setDescription('Days of their messages to delete (0-7)')
          .setMinValue(0)
          .setMaxValue(7),
      ),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.BanMembers)) {
        return fail(interaction, 'You need the Ban Members permission to do this.');
      }

      const { guild } = interaction;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? DEFAULT_REASON;
      const deleteDays = interaction.options.getInteger('delete_days') ?? 0;

      const member = await fetchMember(guild, user.id);
      if (member) {
        const error = await checkTarget(guild, interaction.user.id, member);
        if (error) return fail(interaction, error);
      }

      await dmUser(user, makeEmbed('error', `You were banned from ${guild.name}`, `**Reason:** ${reason}`));
      await guild.bans.create(user.id, {
        reason: `${reason} (by ${interaction.user.username})`,
        deleteMessageSeconds: deleteDays * DAY_MS / 1000,
      });
      await logModeration(interaction, 'Member banned', user.id, reason);
      return interaction.reply({
        embeds: [makeEmbed('error', 'User banned', `<@${user.id}> was banned.\n**Reason:** ${reason}`)],
      });
    },
  },

  unban: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Unban a user (pick from the ban list, or give their ID)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((option) =>
        option.setName('user_id').setDescription('ID of the user to unban (leave empty to pick from a list)'),
      ),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.BanMembers)) {
        return fail(interaction, 'You need the Ban Members permission to do this.');
      }

      const { guild } = interaction;
      const userId = interaction.options.getString('user_id')?.trim();

      if (userId) {
        const removed = await guild.bans
          .remove(userId, `Unbanned by ${interaction.user.username}`)
          .then(() => true)
          .catch(() => false);
        if (!removed) return fail(interaction, 'That user is not banned or the ID is invalid.');

        await logModeration(interaction, 'Member unbanned', userId, 'Unbanned by ID');
        return interaction.reply({ embeds: [makeEmbed('success', 'User unbanned', `<@${userId}> was unbanned.`)] });
      }

      const bans = await guild.bans.fetch();
      if (!bans.size) return fail(interaction, 'There are no banned users in this server.');

      const menu = new StringSelectMenuBuilder()
        .setCustomId('unban:select')
        .setPlaceholder('Select a user to unban')
        .addOptions(
          bans.first(25).map((ban) => ({
            label: truncate(ban.user.username, 100),
            description: truncate(ban.reason || DEFAULT_REASON, 100),
            value: ban.user.id,
          })),
        );

      return interaction.reply({
        content: 'Select a user to unban:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  timeout: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout (mute) a member for a while')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to timeout').setRequired(true))
      .addIntegerOption((option) =>
        option.setName('duration').setDescription('How long').setRequired(true).setMinValue(1).setMaxValue(999),
      )
      .addStringOption((option) =>
        option
          .setName('unit')
          .setDescription('Time unit (default: minutes)')
          .addChoices(
            { name: 'Minutes', value: 'minutes' },
            { name: 'Hours', value: 'hours' },
            { name: 'Days', value: 'days' },
          ),
      )
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500)),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
        return fail(interaction, 'You need the Timeout Members permission to do this.');
      }

      const user = interaction.options.getUser('user', true);
      const duration = interaction.options.getInteger('duration', true);
      const unit = interaction.options.getString('unit') ?? 'minutes';
      const reason = interaction.options.getString('reason') ?? DEFAULT_REASON;
      const ms = duration * TIMEOUT_UNITS[unit];
      const label = `${duration} ${unit}`;

      if (ms > MAX_TIMEOUT_MS) return fail(interaction, 'A timeout can last at most 28 days.');

      const member = await getModeratableMember(interaction, user);
      if (!member) return;

      await dmUser(user, makeEmbed('warn', `You were timed out in ${interaction.guild.name}`, `**Duration:** ${label}\n**Reason:** ${reason}`));
      await member.timeout(ms, `${reason} (by ${interaction.user.username})`);
      await logModeration(interaction, 'Member timed out', user.id, reason, `\n**Duration:** ${label}`);
      return interaction.reply({
        embeds: [makeEmbed('warn', 'Member timed out', `<@${user.id}> was timed out for ${label}.\n**Reason:** ${reason}`)],
      });
    },
  },

  untimeout: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Remove a timeout from a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to untimeout').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500)),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
        return fail(interaction, 'You need the Timeout Members permission to do this.');
      }

      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? DEFAULT_REASON;
      const member = await getModeratableMember(interaction, user);
      if (!member) return;

      if (!member.isCommunicationDisabled()) return fail(interaction, 'That member is not timed out.');

      await member.timeout(null, `${reason} (by ${interaction.user.username})`);
      await logModeration(interaction, 'Timeout removed', user.id, reason);
      return interaction.reply({
        embeds: [makeEmbed('success', 'Timeout removed', `<@${user.id}> can talk again.\n**Reason:** ${reason}`)],
      });
    },
  },
};
