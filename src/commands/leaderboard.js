const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { levelsConfig, progressOf, rankOf } = require('../levels');
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

    const lines = top.map(([id, user], i) => {
      const { level } = progressOf(user.xp);
      return `**${i + 1}.** <@${id}>: level ${level} (${user.xp} XP, rank #${rankOf(cfg, id)})`;
    });
    return interaction.reply({
      embeds: [makeEmbed('info', 'Leaderboard', lines.join('\n'))],
      allowedMentions: { parse: [] },
    });
  },
};
