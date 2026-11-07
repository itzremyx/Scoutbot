const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { fail, hasPerm, makeEmbed, sendLog } = require('../utils');
const { addModlogEntry } = require('../modlog');

const MAX_LOCKDOWN_CHANNELS = 200;

// Lock or unlock every text channel the bot can manage, in one command.
async function setLockdown(interaction, locked) {
  if (!hasPerm(interaction, PermissionFlagsBits.ManageChannels)) {
    return fail(interaction, 'You need the Manage Channels permission to do this.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const everyone = interaction.guild.roles.everyone;
  const reason = `${locked ? 'Locked down' : 'Unlocked'} by ${interaction.user.username}`;
  let changed = 0;
  const skipped = [];
  for (const channel of interaction.guild.channels.cache.values()) {
    if (!channel.isTextBased() || !channel.manageable) continue;
    try {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: locked ? false : null }, { reason });
      changed += 1;
    } catch {
      skipped.push(channel.name ?? channel.id);
    }
  }

  addModlogEntry(interaction.guild.id, {
    userId: interaction.user.id,
    action: locked ? 'lockdown' : 'unlockdown',
    reason: `${locked ? 'Locked' : 'Unlocked'} ${changed} channel(s)${skipped.length ? ` (${skipped.length} skipped)` : ''}`,
    moderatorId: interaction.user.id,
  });
  await sendLog(interaction.guild, {
    embeds: [makeEmbed('info', locked ? 'Server locked down' : 'Server unlocked', `**Channels:** ${changed}\n**Moderator:** <@${interaction.user.id}>`)],
  });

  const summary = changed
    ? `${locked ? 'Locked' : 'Unlocked'} **${changed}** channel(s).`
    : 'No channels were changed (all were already in that state or missing permissions).';
  const note = skipped.length ? `\nSkipped: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` (+${skipped.length - 5})` : ''}` : '';
  return interaction.editReply({
    embeds: [makeEmbed(locked ? 'warn' : 'success', locked ? '🔒 Lockdown' : '🔓 Lockdown off', `${summary}${note}`)],
  });
}

const lockdown = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Lock every text channel: members can no longer send messages anywhere')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  execute: (interaction) => setLockdown(interaction, true),
};

const unlockdown = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('unlockdown')
    .setDescription('Let members send messages in every text channel again')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  execute: (interaction) => setLockdown(interaction, false),
};

module.exports = { lockdown, unlockdown };
