const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const budget = require('../budget');
const ai = require('../ai');
const loader = require('../loader');
const store = require('../storage');
const presence = require('../presence');
const { formatDuration, makeEmbed } = require('../utils');

module.exports = {
  ownerOnly: true,
  data: new SlashCommandBuilder().setName('debug').setDescription('Show safe bot diagnostics (bot owner only)'),

  async execute(interaction) {
    const memory = process.memoryUsage();
    const status = budget.status();
    const embed = makeEmbed('info', 'ScoutBot diagnostics', 'Sensitive values are intentionally hidden.')
      .addFields(
        { name: 'Owner ID', value: config.owner.id, inline: true },
        { name: 'Commands', value: String(loader.commandCount()), inline: true },
        { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
        { name: 'Node', value: process.version, inline: true },
        { name: 'Memory', value: `${(memory.rss / 1024 / 1024).toFixed(1)} MB`, inline: true },
        { name: 'Presence', value: interaction.client.user?.presence?.status ?? presence.configured(), inline: true },
        { name: 'Chat endpoint', value: config.ai.baseUrl, inline: false },
        { name: 'Image endpoint', value: `${config.ai.imageBaseUrl}${config.ai.imageEndpoint}`, inline: false },
        { name: 'Configured model', value: config.ai.model, inline: true },
        { name: 'Provider model', value: ai.lastModel() ?? 'not used yet', inline: true },
        { name: 'Fallback', value: config.ai.fallbackModel, inline: true },
        { name: 'AI key', value: config.ai.apiKey ? 'configured' : 'missing', inline: true },
        { name: 'GitHub token', value: config.githubToken ? 'configured' : 'not configured', inline: true },
        { name: 'Image key', value: config.ai.imageApiKey ? 'configured' : 'missing', inline: true },
        { name: 'Counters', value: `${status.callsToday} calls, ${status.imageCallsToday} images, ${status.tokensToday.toLocaleString('en-US')} tokens today`, inline: false },
        { name: 'Store', value: `${Object.keys(store.data.guilds).length} guild records, ${Object.keys(store.data.users).length} users`, inline: false },
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
