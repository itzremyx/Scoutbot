const {
  MessageFlags,
  ActionRowBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { checkTarget, dmUser, fail, fetchMember, formatDuration, hasPerm, makeEmbed, sendLog, truncate } = require('../utils');
const { addModlogEntry } = require('../modlog');
const { addPunishment, clearForUser, listPunishments, parseDuration } = require('../punishments');

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

function logModeration(interaction, action, title, userId, reason, extra = '') {
  // Keeps the permanent history (/modlog) next to the channel log.
  addModlogEntry(interaction.guild.id, { userId, action, reason, moderatorId: interaction.user.id });
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
  clearForUser(interaction.guild.id, userId, 'tempban');
  await logModeration(interaction, 'unban', 'Member unbanned', userId, 'Unbanned from the ban list');
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
      // History only: the channel log is posted by the member-leave handler, which sees the same kick.
      addModlogEntry(interaction.guild.id, { userId: user.id, action: 'kick', reason, moderatorId: interaction.user.id });
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

      await dmUser(
        user,
        makeEmbed(
          'error',
          `You were banned from ${guild.name}`,
          `**Reason:** ${reason}\n\nTo appeal, reply to this DM with \`appeal <your reason>\`.`,
        ),
      );
      await guild.bans.create(user.id, {
        reason: `${reason} (by ${interaction.user.username})`,
        deleteMessageSeconds: deleteDays * DAY_MS / 1000,
      });
      await logModeration(interaction, 'ban', 'Member banned', user.id, reason);
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

        clearForUser(guild.id, userId, 'tempban');
        await logModeration(interaction, 'unban', 'Member unbanned', userId, 'Unbanned by ID');
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
      await logModeration(interaction, 'timeout', 'Member timed out', user.id, reason, `\n**Duration:** ${label}`);
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
      clearForUser(interaction.guild.id, user.id, 'tempmute');
      await logModeration(interaction, 'untimeout', 'Timeout removed', user.id, reason);
      return interaction.reply({
        embeds: [makeEmbed('success', 'Timeout removed', `<@${user.id}> can talk again.\n**Reason:** ${reason}`)],
      });
    },
  },

  tempban: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('tempban')
      .setDescription('Ban a user for a set time, then unban them automatically')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((option) => option.setName('user').setDescription('User to ban').setRequired(true))
      .addStringOption((option) =>
        option.setName('duration').setDescription('How long, e.g. 1h, 1d, 7d or 1d 12h (max 30 days)').setRequired(true),
      )
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500))
      .addIntegerOption((option) =>
        option.setName('delete_days').setDescription('Days of their messages to delete (0-7)').setMinValue(0).setMaxValue(7),
      ),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.BanMembers)) {
        return fail(interaction, 'You need the Ban Members permission to do this.');
      }

      const { guild } = interaction;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? DEFAULT_REASON;
      const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
      const ms = parseDuration(interaction.options.getString('duration', true));
      if (!ms) return fail(interaction, 'Invalid duration. Use something like `1h`, `1d`, `7d` or `1d 12h` (1 minute to 30 days).');

      const member = await fetchMember(guild, user.id);
      if (member) {
        const error = await checkTarget(guild, interaction.user.id, member);
        if (error) return fail(interaction, error);
      }

      const expiresAt = Date.now() + ms;
      const label = formatDuration(ms);
      await dmUser(
        user,
        makeEmbed(
          'error',
          `You were temporarily banned from ${guild.name}`,
          `**Duration:** ${label}\n**Reason:** ${reason}\n\nTo appeal, reply to this DM with \`appeal <your reason>\`.`,
        ),
      );
      await guild.bans.create(user.id, {
        reason: `${reason} (by ${interaction.user.username}, ${label})`,
        deleteMessageSeconds: (deleteDays * DAY_MS) / 1000,
      });
      addPunishment(guild.id, { type: 'tempban', userId: user.id, reason, moderatorId: interaction.user.id, expiresAt });
      await logModeration(
        interaction,
        'tempban',
        'Member temporarily banned',
        user.id,
        reason,
        `\n**Duration:** ${label}\n**Auto-unban:** <t:${Math.floor(expiresAt / 1000)}:R>`,
      );
      return interaction.reply({
        embeds: [
          makeEmbed(
            'error',
            'User temporarily banned',
            `<@${user.id}> was banned for ${label}.\n**Reason:** ${reason}\n**Auto-unban:** <t:${Math.floor(expiresAt / 1000)}:R>`,
          ),
        ],
      });
    },
  },

  tempmute: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('tempmute')
      .setDescription('Timeout a member for a set time, tracked as a temporary punishment')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to mute').setRequired(true))
      .addStringOption((option) =>
        option.setName('duration').setDescription('How long, e.g. 30m, 2h, 7d or 1d 12h (max 28 days)').setRequired(true),
      )
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500)),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
        return fail(interaction, 'You need the Timeout Members permission to do this.');
      }

      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? DEFAULT_REASON;
      const ms = parseDuration(interaction.options.getString('duration', true), MAX_TIMEOUT_MS);
      if (!ms) return fail(interaction, 'Invalid duration. Use something like `30m`, `2h`, `7d` or `1d 12h` (1 minute to 28 days).');

      const member = await getModeratableMember(interaction, user);
      if (!member) return;

      const expiresAt = Date.now() + ms;
      const label = formatDuration(ms);
      await dmUser(
        user,
        makeEmbed('warn', `You were muted in ${interaction.guild.name}`, `**Duration:** ${label}\n**Reason:** ${reason}`),
      );
      await member.timeout(ms, `${reason} (by ${interaction.user.username})`);
      addPunishment(interaction.guild.id, { type: 'tempmute', userId: user.id, reason, moderatorId: interaction.user.id, expiresAt });
      await logModeration(
        interaction,
        'tempmute',
        'Member temporarily muted',
        user.id,
        reason,
        `\n**Duration:** ${label}\n**Ends:** <t:${Math.floor(expiresAt / 1000)}:R>`,
      );
      return interaction.reply({
        embeds: [
          makeEmbed(
            'warn',
            'Member temporarily muted',
            `<@${user.id}> is muted for ${label}.\n**Reason:** ${reason}\n**Ends:** <t:${Math.floor(expiresAt / 1000)}:R>`,
          ),
        ],
      });
    },
  },

  punishments: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('punishments')
      .setDescription('List active temporary bans and mutes')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
        return fail(interaction, 'You need the Moderate Members permission to do this.');
      }

      const items = listPunishments(interaction.guild.id);
      const text = items.length
        ? items
            .map(
              (item) =>
                `**#${item.id}** ${item.type === 'tempban' ? 'Ban' : 'Mute'} <@${item.userId}> — ends <t:${Math.floor(item.expiresAt / 1000)}:R>\n${truncate(item.reason || DEFAULT_REASON, 200)}`,
            )
            .join('\n\n')
        : 'No temporary punishment is active.';
      return interaction.reply({ embeds: [makeEmbed('info', 'Active temporary punishments', truncate(text, 4000))] });
    },
  },

  pardon: {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName('pardon')
      .setDescription('Lift a temporary ban or mute before it expires')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to pardon').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(500)),

    async execute(interaction) {
      if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
        return fail(interaction, 'You need the Moderate Members permission to do this.');
      }

      const { guild } = interaction;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? 'Pardoned';
      const active = listPunishments(guild.id).filter((item) => item.userId === user.id);
      if (!active.length) return fail(interaction, 'That user has no active temporary punishment.');

      const removed = [];
      for (const item of active) {
        if (item.type === 'tempban') {
          const unbanned = await guild.bans
            .remove(user.id, `Pardoned by ${interaction.user.username}`)
            .then(() => true)
            .catch(() => false);
          if (unbanned) removed.push('ban');
        }
        if (item.type === 'tempmute') {
          const member = await fetchMember(guild, user.id);
          if (member?.isCommunicationDisabled()) {
            await member.timeout(null, `Pardoned by ${interaction.user.username}`).catch(() => {});
          }
          removed.push('mute');
        }
      }
      clearForUser(guild.id, user.id, 'tempban');
      clearForUser(guild.id, user.id, 'tempmute');
      await logModeration(interaction, 'pardon', 'Member pardoned', user.id, reason);
      return interaction.reply({
        embeds: [makeEmbed('success', 'Member pardoned', `<@${user.id}>: ${removed.join(' and ') || 'punishment'} lifted.\n**Reason:** ${reason}`)],
      });
    },
  },
};
