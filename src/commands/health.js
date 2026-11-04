const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const budget = require('../budget');
const ai = require('../ai');
const presence = require('../presence');
const { formatDuration, makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder().setName('health').setDescription('Check the bot health and service status'),

  async execute(interaction) {
    const memory = process.memoryUsage();
    const status = interaction.client.user?.presence?.status ?? presence.configured();
    const image = budget.status(interaction.user.id);
    const embed = makeEmbed('success', 'Bot health', 'ScoutBot is online and responding.')
      .addFields(
        { name: 'Status', value: status, inline: true },
        { name: 'WebSocket', value: `${interaction.client.ws.ping}ms`, inline: true },
        { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
        { name: 'Servers', value: String(interaction.client.guilds.cache.size), inline: true },
        { name: 'Memory', value: `${(memory.rss / 1024 / 1024).toFixed(1)} MB`, inline: true },
        { name: 'AI model', value: ai.activeModel(), inline: true },
        { name: 'Image quota', value: `${image.userImagesLeft} left for you today`, inline: true },
        { name: 'AI endpoint', value: config.ai.baseUrl, inline: false },
      );
    return interaction.reply({ embeds: [embed] });
  },
};
