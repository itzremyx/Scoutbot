const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const budget = require('../budget');
const config = require('../config');
const loader = require('../loader');
const store = require('../storage');
const ai = require('../ai');
const { fail, formatDuration, makeEmbed } = require('../utils');

const startedAt = Date.now();

const botstats = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('botstats')
    .setDescription('Show bot statistics (bot owner only)')
    .addSubcommand((sub) => sub.setName('show').setDescription('Uptime, memory, servers and AI usage'))
    .addSubcommand((sub) =>
      sub
        .setName('ai')
        .setDescription('Change the AI budget')
        .addIntegerOption((option) =>
          option.setName('daily_limit').setDescription('Max tokens per UTC day (0 = unlimited)').setMinValue(0),
        )
        .addIntegerOption((option) =>
          option.setName('image_limit').setDescription('Max images per UTC day (0 = unlimited)').setMinValue(0),
        )
        .addIntegerOption((option) =>
          option.setName('cooldown').setDescription('Seconds between AI requests per user').setMinValue(0).setMaxValue(3600),
        )
        .addBooleanOption((option) => option.setName('paused').setDescription('Pause or resume all AI answers'))
        .addBooleanOption((option) => option.setName('reset_today').setDescription("Reset today's counters"))
        .addStringOption((option) => option.setName('model').setDescription('Switch the AI model (empty = back to AI_MODEL from .env)')),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'ai') {
      const dailyLimit = interaction.options.getInteger('daily_limit');
      const imageLimit = interaction.options.getInteger('image_limit');
      const cooldown = interaction.options.getInteger('cooldown');
      const paused = interaction.options.getBoolean('paused');
      const reset = interaction.options.getBoolean('reset_today');
      const model = interaction.options.getString('model');
      if (model !== null) {
        store.data.settings.aiModel = model.trim() || null; // empty string = use .env again
        store.save();
      }
      if (dailyLimit !== null) budget.setLimit(dailyLimit);
      if (imageLimit !== null) budget.setImageLimit(imageLimit);
      if (cooldown !== null) budget.setCooldown(cooldown);
      if (paused !== null) budget.setPaused(paused);
      if (reset) budget.resetToday();
      return interaction.reply({ embeds: [aiEmbed('AI budget updated')], flags: MessageFlags.Ephemeral });
    }

    const mem = process.memoryUsage();
    const embed = makeEmbed('info', '🤖 Bot stats', null)
      .addFields(
        { name: 'Uptime', value: formatDuration(Date.now() - startedAt), inline: true },
        { name: 'Servers', value: String(interaction.client.guilds.cache.size), inline: true },
        { name: 'Ping', value: `${interaction.client.ws.ping}ms`, inline: true },
        { name: 'Memory (RSS)', value: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`, inline: true },
        { name: 'Node', value: process.version, inline: true },
        { name: 'Commands', value: String(loader.commandCount()), inline: true },
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

// Shared by /botstats ai: shows the budget status.
function aiEmbed(title) {
  const s = budget.status();
  const limit = Number.isFinite(s.limit) ? s.limit.toLocaleString('en-US') : 'unlimited';
  const imageLimit = Number.isFinite(s.imageLimit) ? s.imageLimit.toLocaleString('en-US') : 'unlimited';
  return makeEmbed('info', title, null).addFields(
    { name: 'Configured model', value: `\`${ai.activeModel()}\``, inline: true },
    { name: 'Last provider model', value: ai.lastModel() ? `\`${ai.lastModel()}\`` : 'Not used yet', inline: true },
    { name: 'Fallback', value: `\`${config.ai.fallbackModel}\``, inline: true },
    { name: 'Status', value: s.paused ? '⏸️ Paused' : '▶️ Active', inline: true },
    { name: 'Cooldown', value: `${s.cooldownSeconds}s per user`, inline: true },
    { name: 'Daily limit', value: limit, inline: true },
    { name: 'Images today', value: `${s.imageCallsToday} / ${imageLimit}`, inline: true },
    { name: `Used today (${s.day})`, value: `${s.tokensToday.toLocaleString('en-US')} tokens, ${s.callsToday} calls`, inline: false },
    { name: 'All time', value: `${s.totalTokens.toLocaleString('en-US')} tokens, ${s.totalCalls} calls, ${s.totalImageCalls.toLocaleString('en-US')} images`, inline: false },
  );
}

const botreload = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('botreload')
    .setDescription('Reload command files without restarting the bot (bot owner only)'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const count = await loader.reload(interaction.client);
      return interaction.editReply({
        embeds: [makeEmbed('success', 'Reloaded', `Reloaded ${count} commands from disk. Global command updates can take up to an hour to show.`)],
      });
    } catch (err) {
      return fail(interaction, `Reload failed, the previous commands are still active.\n\`\`\`${err.message}\`\`\``);
    }
  },
};

module.exports = { botstats, botreload };
