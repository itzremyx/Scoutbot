const { MessageFlags, ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { buildPanel } = require('../tickets');
const { fail, hasPerm, makeEmbed } = require('../utils');

function settings() {
  return (store.data.settings ??= {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure ScoutBot for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('show').setDescription('Show the current server setup'))
    .addSubcommand((sub) => sub
      .setName('logs')
      .setDescription('Set the moderation and ticket log channel')
      .addChannelOption((option) => option.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('ai')
      .setDescription('Set the channel where every message is answered by the AI')
      .addChannelOption((option) => option.setName('channel').setDescription('AI channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('commits')
      .setDescription('Set the channel for ScoutBot commit announcements')
      .addChannelOption((option) => option.setName('channel').setDescription('Commit channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('autorole')
      .setDescription('Set the role given to members when they join')
      .addRoleOption((option) => option.setName('role').setDescription('Role to assign').setRequired(true)))
    .addSubcommand((sub) => sub.setName('panel').setDescription('Post the ticket panel in this channel')),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to use this command.');
    }
    const sub = interaction.options.getSubcommand();
    const guild = store.guild(interaction.guild.id);
    const current = settings();

    if (sub === 'show') {
      const mention = (id) => id ? `<#${id}>` : 'not set';
      const role = current.autoRoleId ? `<@&${current.autoRoleId}>` : 'not set';
      return interaction.reply({
        embeds: [makeEmbed('info', 'Server setup', 'These settings belong to this ScoutBot installation.')
          .addFields(
            { name: 'Logs', value: mention(guild.logChannelId), inline: true },
            { name: 'AI', value: mention(current.aiChannelId), inline: true },
            { name: 'Commits', value: mention(current.botRepoChannelId), inline: true },
            { name: 'Auto-role', value: role, inline: true },
          )],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'logs') {
      const channel = interaction.options.getChannel('channel', true);
      guild.logChannelId = channel.id;
      store.save();
      return interaction.reply({ embeds: [makeEmbed('success', 'Log channel set', `Logs will be posted in ${channel}.`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'ai') {
      const channel = interaction.options.getChannel('channel', true);
      current.aiChannelId = channel.id;
      store.save();
      return interaction.reply({ embeds: [makeEmbed('success', 'AI channel set', `Every message in ${channel} will be answered.`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'commits') {
      const channel = interaction.options.getChannel('channel', true);
      current.botRepoChannelId = channel.id;
      store.save();
      return interaction.reply({ embeds: [makeEmbed('success', 'Commit channel set', `ScoutBot commits will be posted in ${channel}.`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'autorole') {
      const role = interaction.options.getRole('role', true);
      current.autoRoleId = role.id;
      store.save();
      return interaction.reply({ embeds: [makeEmbed('success', 'Auto-role set', `New members will receive ${role}.`)], flags: MessageFlags.Ephemeral });
    }

    await interaction.channel.send(buildPanel(interaction.guild));
    return interaction.reply({ embeds: [makeEmbed('success', 'Ticket panel posted', 'The panel is live.')], flags: MessageFlags.Ephemeral });
  },
};
