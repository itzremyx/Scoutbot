const { MessageFlags, ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { buildPanel } = require('../tickets');
const { fail, hasPerm, makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the bot for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('logs')
        .setDescription('Set the channel where moderation and ticket logs are posted')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Log channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('panel').setDescription('Post the ticket panel in this channel'),
    ),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to use this command.');
    }

    if (interaction.options.getSubcommand() === 'logs') {
      const channel = interaction.options.getChannel('channel', true);
      store.guild(interaction.guild.id).logChannelId = channel.id;
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Log channel set', `Logs will be posted in ${channel}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.channel.send(buildPanel(interaction.guild));
    return interaction.reply({ embeds: [makeEmbed('success', 'Ticket panel posted', 'The panel is live.')], flags: MessageFlags.Ephemeral });
  },
};
