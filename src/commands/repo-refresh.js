const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const botrepo = require('../botrepo');
const updates = require('../updates');
const { makeEmbed } = require('../utils');

module.exports = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('repo-refresh')
    .setDescription('Check ScoutCode and ScoutBot repositories now (bot owner only)'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [scoutCode, scoutBot] = await Promise.all([
      updates.checkOnce(interaction.client),
      botrepo.checkOnce(interaction.client),
    ]);
    return interaction.editReply({
      embeds: [makeEmbed(
        'success',
        'Repository refresh complete',
        `ScoutCode commits posted: **${scoutCode}**\nScoutBot commits posted: **${scoutBot}**`,
      )],
      flags: MessageFlags.Ephemeral,
    });
  },
};
