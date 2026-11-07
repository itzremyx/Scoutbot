const { SlashCommandBuilder } = require('discord.js');
const { makeEmbed, truncate } = require('../utils');
const store = require('../storage');

const MAX_LIST = 10;

// The invite leaderboard. Every member who joined through a link gets credit to that inviter
// (src/welcome.js tracks it on each join); "leaves" counts how many of their members left again,
// so the "still here" figure is net of churn.
function rankers(guildId) {
  const guild = store.guild(guildId);
  return Object.entries(guild.invites ?? {})
    .map(([inviterId, entry]) => ({
      inviterId,
      regular: entry.regular ?? 0,
      leaves: entry.leaves ?? 0,
      present: (entry.regular ?? 0) - (entry.leaves ?? 0),
    }))
    .sort((a, b) => b.regular - a.regular || b.present - a.present);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Show the invite count for you or a member')
    .addUserOption((option) => option.setName('user').setDescription('Member to look up')),

  guildOnly: true,

  async execute(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    await interaction.deferReply();

    const rankersAll = rankers(interaction.guild.id);
    const entry = rankersAll.find((item) => item.inviterId === target.id);
    const index = rankersAll.findIndex((item) => item.inviterId === target.id);
    const rows = [];

    rows.push(`**Invites:** **${entry ? entry.regular : 0}**`);
    if (entry) {
      if (entry.leaves) rows.push(`**Left:** ${entry.leaves} · **Still here:** ${entry.present}`);
      rows.push(`**Rank:** #${index + 1} of ${rankersAll.length}`);
    }

    const top = await Promise.all(rankersAll.slice(0, MAX_LIST).map(async (item, i) => {
      const member = await interaction.guild.members.fetch(item.inviterId).catch(() => null);
      const name = member ? `<@${item.inviterId}>` : `<@!${item.inviterId}> (left)`;
      return `${i + 1}. ${name} — **${item.regular}** invite${item.regular === 1 ? '' : 's'}`;
    }));

    const embed = makeEmbed(
      'info',
      `Invites — ${target.username}${target.id === interaction.user.id ? ' (you)' : ''}`,
      rows.length ? rows.join('\n') : 'No invites recorded yet.',
    );
    if (top.length) embed.addFields({ name: 'Leaderboard', value: truncate(top.join('\n'), 1024) });
    return interaction.editReply({ embeds: [embed] });
  },
};
