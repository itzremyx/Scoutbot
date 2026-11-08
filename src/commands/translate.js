const { SlashCommandBuilder } = require('discord.js');
const { translateText } = require('../translate');
const { makeEmbed, truncate } = require('../utils');

const LANGUAGES = [
  'English',
  'French',
  'Spanish',
  'German',
  'Portuguese',
  'Italian',
  'Dutch',
  'Japanese',
  'Korean',
  'Chinese',
  'Arabic',
  'Russian',
  'Hindi',
  'Turkish',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Translate a message into another language')
    .addStringOption((option) =>
      option.setName('text').setDescription('The text to translate').setRequired(true).setMaxLength(3000),
    )
    .addStringOption((option) =>
      option
        .setName('to')
        .setDescription('Target language (default: English)')
        .addChoices(...LANGUAGES.map((language) => ({ name: language, value: language }))),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const text = interaction.options.getString('text', true).trim();
    const target = interaction.options.getString('to') || 'English';

    const translated = await translateText(text, target);
    if (!translated) {
      return interaction.editReply({
        embeds: [makeEmbed('error', 'Translation failed', 'The translation service did not answer. Try again in a moment.')],
      });
    }

    const embed = makeEmbed('info', `🌐 Translation (${target})`, truncate(translated, 3900));
    embed.addFields({ name: 'Original', value: truncate(text, 1000) });
    return interaction.editReply({ embeds: [embed] });
  },
};
