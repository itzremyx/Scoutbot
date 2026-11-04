const { SlashCommandBuilder } = require('discord.js');
const loader = require('../loader');
const { helpPayload } = require('../help');
const { isBotOwner } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('Show the commands by category'),

  async execute(interaction) {
    const isOwner = await isBotOwner(interaction.client, interaction.user.id);
    return interaction.reply(helpPayload(loader.allCommands(), isOwner, interaction.locale));
  },
};
