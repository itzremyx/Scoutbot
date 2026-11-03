const { SlashCommandBuilder } = require('discord.js');
const ai = require('../ai');
const { fail, splitText, truncate } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the bot a question')
    .addStringOption((option) =>
      option.setName('question').setDescription('What do you want to ask?').setRequired(true).setMaxLength(1000),
    )
    .addAttachmentOption((option) =>
      option.setName('image').setDescription('Optional image for the bot to read').setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const question = interaction.options.getString('question', true);
    const image = interaction.options.getAttachment('image');
    const imageUrls = image && (image.contentType?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:\?|$)/i.test(image.url ?? ''))
      ? [image.url]
      : [];
    if (image && !imageUrls.length) return fail(interaction, 'That attachment is not an image.');

    try {
      const answer = await ai.chat({
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        botName: interaction.client.user.username,
        userId: interaction.user.id,
        speaker: interaction.user.username,
        question,
        imageUrls,
      });
      const [first, ...rest] = splitText(answer, 1700);
      await interaction.editReply({ content: `**Q:** ${truncate(question, 200)}\n\n${first}` });
      for (const part of rest) await interaction.followUp(part);
    } catch (err) {
      await fail(interaction, err.message);
    }
  },
};
