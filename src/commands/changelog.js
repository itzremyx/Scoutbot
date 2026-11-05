const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const updates = require('../updates');
const botrepo = require('../botrepo');

const HEADERS = {
  scoutbot: { label: 'ScoutBot', color: 0xff9033, icon: 'https://github.com/itzremyx.png', repo: 'itzremyx/Scoutbot' },
  scoutcode: { label: 'ScoutCode', color: 0x5865f2, icon: 'https://github.com/gentraxyz.png', repo: 'gentraxyz/scoutcode' },
};

async function buildList(name, count) {
  const head = HEADERS[name];
  const fetcher = name === 'scoutbot' ? botrepo.recentCommits : updates.recentCommits;
  const commits = await fetcher(count);
  const lines = commits.map((c, i) => {
    const who = c.githubAuthor || c.author || 'unknown';
    const date = new Date(c.date).toISOString().slice(0, 10);
    return `**${i + 1}. [${c.sha.slice(0, 7)}](${c.url})** \`${who}\` — ${date}`;
  });
  return new EmbedBuilder()
    .setColor(head.color)
    .setAuthor({ name: `${head.label} — latest commits`, iconURL: head.icon, url: `https://github.com/${head.repo}` })
    .setDescription(commits.length ? lines.join('\n') : 'No commits found.')
    .setFooter({ text: `${commits.length} commit(s) from ${head.repo}` })
    .setTimestamp();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('changelog')
    .setDescription('Show the latest commits for ScoutBot or ScoutCode')
    .addStringOption((o) =>
      o.setName('repo').setDescription('Which repository').setRequired(true)
        .addChoices(
          { name: 'ScoutBot', value: 'scoutbot' },
          { name: 'ScoutCode', value: 'scoutcode' },
          { name: 'Both', value: 'both' },
        ))
    .addIntegerOption((o) =>
      o.setName('count').setDescription('How many commits (1-20)').setMinValue(1).setMaxValue(20).setRequired(false)),

  async execute(interaction) {
    const repo = interaction.options.getString('repo');
    const count = interaction.options.getInteger('count') ?? 5;
    await interaction.deferReply({ flags: 64 });
    try {
      if (repo === 'both') {
        const [bot, code] = await Promise.all([
          buildList('scoutbot', count),
          buildList('scoutcode', count),
        ]);
        return interaction.editReply({ embeds: [bot, code] });
      }
      const embed = await buildList(repo, count);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`Could not fetch commits: \`${err.message}\``);
    }
  },
};
