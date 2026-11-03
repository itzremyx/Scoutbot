const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const ai = require('../ai');
const budget = require('../budget');
const { fail, truncate } = require('../utils');

// GPT-5 Image Mini's Image API supports these aspect ratios directly.
const RATIOS = ['1:1', '3:2', '2:3', 'auto'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('imagine')
    .setDescription('Generate an image with AI')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('What to draw').setRequired(true).setMaxLength(1000),
    )
    .addStringOption((option) =>
      option.setName('ratio').setDescription('Aspect ratio (default 1:1)').addChoices(...RATIOS.map((r) => ({ name: r, value: r }))),
    )
    .addIntegerOption((option) =>
      option.setName('count').setDescription('How many images (default 1)').setMinValue(1).setMaxValue(4),
    ),

  async execute(interaction) {
    const prompt = interaction.options.getString('prompt', true).trim();
    const ratio = interaction.options.getString('ratio') ?? '1:1';
    const count = interaction.options.getInteger('count') ?? 1;
    if (!prompt) return fail(interaction, 'Give me something to draw.');

    const left = budget.imagesLeft();
    if (left !== Infinity && left < count) {
      return fail(interaction, `Only ${left} image(s) left today (limit resets at 00:00 UTC). Try fewer images.`);
    }

    await interaction.deferReply(); // generation can take a while
    try {
      const { images, failed } = await ai.generateImages({
        userId: interaction.user.id,
        prompt,
        ratio,
        count,
      });

      const files = images.map(
        (buffer, index) => new AttachmentBuilder(buffer, { name: `imagine-${index + 1}.png` }),
      );
      const note = failed ? `\n⚠️ ${failed} image(s) were blocked by content safety.` : '';
      await interaction.editReply({ content: `**Prompt:** ${truncate(prompt, 800)} (${ratio})${note}`, files });
    } catch (err) {
      await fail(interaction, err.message);
    }
  },
};
