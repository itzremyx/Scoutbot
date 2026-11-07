const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { fail, hasPerm, makeEmbed } = require('../utils');
const { addModlogEntry } = require('../modlog');

// Highest role position a member holds (0 for no role).
const highestRolePosition = (member) =>
  member?.roles?.cache?.reduce((best, role) => (role.position > best ? role.position : best), 0) ?? 0;

// Rename a member. The bot needs Manage Nicknames and a role above the target's highest role.
async function setNick(interaction, target, nickname) {
  if (!hasPerm(interaction, PermissionFlagsBits.ManageNicknames)) {
    return fail(interaction, 'You need the Manage Nicknames permission to do this.');
  }

  const clean = String(nickname ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > 32) return fail(interaction, 'Nicknames are limited to 32 characters.');

  const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!targetMember) return fail(interaction, 'That user is not in this server.');
  if (targetMember.id === interaction.client.user.id) return fail(interaction, 'I cannot rename myself here.');
  if (targetMember.bot) return fail(interaction, 'Bot nicknames cannot be changed here.');

  const botTop = highestRolePosition(interaction.guild.members.me);
  if (highestRolePosition(targetMember) > botTop) {
    return fail(interaction, 'That member has a role at or above my highest role — I cannot change their nickname.');
  }

  const old = targetMember.nickname ?? targetMember.user.username;
  await targetMember.setNickname(clean || null, `Nickname set by ${interaction.user.username}`);
  addModlogEntry(interaction.guild.id, {
    userId: interaction.user.id,
    action: 'nickname',
    reason: `<@${target.id}>: "${old}" → "${clean || targetMember.user.username}"`,
    moderatorId: interaction.user.id,
    meta: { target: target.id },
  });
  const detail = clean
    ? `${targetMember.user.username} is now nicknamed **${clean}** in this server.`
    : `The nickname of ${targetMember.user.username} has been cleared.`;
  return interaction.reply({
    embeds: [makeEmbed('success', 'Nickname updated', detail)],
  });
}

const nick = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('nick')
    .setDescription("Change a member's nickname in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption((option) => option.setName('user').setDescription('Member to rename').setRequired(true))
    .addStringOption((option) =>
      option.setName('nickname').setDescription('New nickname (empty clears it, max 32 characters)').setMaxLength(32).setRequired(true),
    ),
  execute: (interaction) => setNick(interaction, interaction.options.getUser('user', true), interaction.options.getString('nickname', true)),
};

module.exports = nick;
