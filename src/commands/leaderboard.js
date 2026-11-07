const { AttachmentBuilder, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { levelsConfig, progressOf, rankOf } = require('../levels');
const { renderLeaderboardCard } = require('../rankcard');
const { makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top members by XP'),

  guildOnly: true,

  async execute(interaction) {
    const cfg = levelsConfig(interaction.guild.id);
    const top = Object.entries(cfg.users)
      .sort(([, a], [, b]) => b.xp - a.xp)
      .slice(0, 10);
    if (!top.length) {
      return interaction.reply({ embeds: [makeEmbed('info', 'Leaderboard', 'Nobody has XP yet.')], flags: MessageFlags.Ephemeral });
    }

    const entries = await Promise.all(top.map(async ([id, user]) => {
      const { level } = progressOf(user.xp);
      const member = await interaction.guild.members.fetch(id).catch(() => null);
      const username = member ? (member.user.globalName ?? member.user.username) : 'Unknown';
      return { id, username, level, xp: user.xp };
    }));

    const png = await renderLeaderboardCard({ entries, themeId: cfg.theme });
    const file = new AttachmentBuilder(png, { name: 'leaderboard.png' });
    return interaction.reply({
      files: [file],
      content: `**Leaderboard** — top ${entries.length}`,
      allowedMentions: { parse: [] },
    });
  },
};
