const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const presence = require('../presence');
const { makeEmbed } = require('../utils');

module.exports = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('presence')
    .setDescription('Change the bot presence (bot owner only)')
    .addStringOption((option) => option
      .setName('status')
      .setDescription('Presence mode')
      .setRequired(true)
      .addChoices(...presence.MODES.map((mode) => ({ name: mode[0].toUpperCase() + mode.slice(1), value: mode })))),

  async execute(interaction) {
    const status = await presence.apply(interaction.client, interaction.options.getString('status', true));
    return interaction.reply({ embeds: [makeEmbed('success', 'Presence updated', `The bot is now **${status}**.`)], flags: MessageFlags.Ephemeral });
  },
};
