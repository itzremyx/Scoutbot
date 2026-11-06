const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your ScoutCode account to earn $0.25')
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('The 6-character linking code from your ScoutCode account')
        .setRequired(true)
    ),

  async execute(interaction) {
    const rawCode = interaction.options.getString('code', true).trim();
    if (!rawCode) {
      return interaction.reply({
        embeds: [makeEmbed('warn', 'Missing Code', 'Please provide a valid linking code from your ScoutCode account.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const apiUrl = `${config.siteUrl}/api/discord/link`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Scoutbot/1.0',
    };
    if (config.discordBotSecret) {
      headers['Authorization'] = `Bearer ${config.discordBotSecret}`;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: rawCode,
          discordId: interaction.user.id,
          discordTag: interaction.user.tag || interaction.user.username,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        const errorMsg = data?.error || `Request failed with status ${res.status}`;
        const embed = makeEmbed('error', 'Account Linking Failed', errorMsg);
        return interaction.editReply({ embeds: [embed] });
      }

      const rewardFormatted = `$${Number(data.reward || 0.25).toFixed(2)}`;
      const embed = makeEmbed(
        'success',
        'Account Linked!',
        `Your Discord account has been successfully linked to ScoutCode account **${data.username}**.\n\n**${rewardFormatted}** has been added to your permanent balance!`
      );
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Scoutbot link error]', err);
      const isTimeout = err.name === 'AbortError';
      const msg = isTimeout
        ? 'Connecting to ScoutCode timed out. Please try again in a moment.'
        : 'Could not reach the ScoutCode server. Please try again later.';
      const embed = makeEmbed('error', 'Connection Error', msg);
      return interaction.editReply({ embeds: [embed] });
    }
  },
};
