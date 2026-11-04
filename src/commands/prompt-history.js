const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const ai = require('../ai');
const { makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('prompt-history')
    .setDescription('View or clear your recent image prompts')
    .addSubcommand((sub) => sub.setName('show').setDescription('Show your recent prompts'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Clear your recent prompts')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'clear') {
      ai.clearPromptHistory(interaction.user.id);
      return interaction.reply({ content: 'Your image prompt history was cleared.', flags: MessageFlags.Ephemeral });
    }
    const history = ai.promptHistory(interaction.user.id);
    const description = history.length
      ? history.map((prompt, index) => `**${index + 1}.** ${prompt}`).join('\n')
      : 'No image prompts saved yet.';
    return interaction.reply({ embeds: [makeEmbed('info', 'Recent image prompts', description)], flags: MessageFlags.Ephemeral });
  },
};
