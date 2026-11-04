const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const budget = require('../budget');
const config = require('../config');
const { makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder().setName('image-quota').setDescription('Show your daily AI image quota'),

  async execute(interaction) {
    const status = budget.status(interaction.user.id);
    const limit = Number.isFinite(status.imagePerUserLimit) ? status.imagePerUserLimit : 'unlimited';
    const remaining = status.userImagesLeft === Infinity ? 'unlimited' : status.userImagesLeft;
    const dailyLimit = Number.isFinite(status.imageLimit) ? status.imageLimit : 'unlimited';
    const embed = makeEmbed('info', 'Image quota', 'Your image generation allowance resets at **00:00 UTC**.')
      .addFields(
        { name: 'Your limit', value: `${limit} image(s) per day`, inline: true },
        { name: 'Remaining', value: String(remaining), inline: true },
        { name: 'Server daily usage', value: `${status.imageCallsToday} / ${dailyLimit}`, inline: true },
        { name: 'Provider', value: config.ai.imageModel, inline: false },
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
