const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { makeEmbed, truncate, hasPerm } = require('../utils');
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
    .setDescription('View and manage invite stats')
    .addSubcommand((sub) =>
      sub.setName('show')
        .setDescription('Show invite stats for a member')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to look up')),
    )
    .addSubcommand((sub) =>
      sub.setName('add')
        .setDescription('Add fake invites to a member')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to modify').setRequired(true))
        .addIntegerOption((opt) => opt.setName('count').setDescription('Number of invites to add').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('remove')
        .setDescription('Remove invites from a member')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to modify').setRequired(true))
        .addIntegerOption((opt) => opt.setName('count').setDescription('Number of invites to remove').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('reset')
        .setDescription('Reset all invite stats for this server'),
    ),

  guildOnly: true,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const guildData = store.guild(guildId);
    await interaction.deferReply({ ephemeral: sub !== 'show' });

    if (sub === 'show') {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const rankersAll = rankers(guildId);
      const entry = rankersAll.find((item) => item.inviterId === target.id);
      const index = rankersAll.findIndex((item) => item.inviterId === target.id);
      const rows = [];
      rows.push(`**Invites:** **${entry ? entry.regular : 0}**`);
      if (entry) {
        if (entry.leaves) rows.push(`**Left:** ${entry.leaves} · **Still here:** ${entry.present}`);
        rows.push(`**Total (incl. left):** **${entry.regular + entry.leaves}**`);
        rows.push(`**Rank:** #${index + 1} of ${rankersAll.length}`);
      }
      const top = await Promise.all(rankersAll.slice(0, MAX_LIST).map(async (item) => {
        const member = await interaction.guild.members.fetch(item.inviterId).catch(() => null);
        const name = member ? member.user.username : `ID:${item.inviterId}`;
        return `${name} — **${item.regular}** invite${item.regular === 1 ? '' : 's'} (left ${item.leaves})`;
      }));
      const embed = makeEmbed(
        'info',
        `Invites — ${target.username}${target.id === interaction.user.id ? ' (you)' : ''}`,
        rows.length ? rows.join('\n') : 'No invites recorded yet.',
      );
      if (top.length) embed.addFields({ name: 'Leaderboard', value: truncate(top.join('\n'), 1024) });
      await interaction.editReply({ embeds: [embed] });
    } else if (sub === 'add' || sub === 'remove') {
      if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply({
          embeds: [makeEmbed('error', 'Permission denied', 'You need Manage Server permission to modify invites.')],
        });
      }
      const user = interaction.options.getUser('user', true);
      const count = interaction.options.getInteger('count');
      const entry = (guildData.invites ??= {})[user.id] ??= { regular: 0, leaves: 0 };
      if (sub === 'add') {
        entry.regular += count;
        await interaction.editReply({ embeds: [makeEmbed('success', 'Invites added', `${count} invites added to ${user.username}.`)] });
      } else {
        const newVal = Math.max(0, entry.regular - count);
        const removed = entry.regular - newVal;
        entry.regular = newVal;
        await interaction.editReply({ embeds: [makeEmbed('success', 'Invites removed', `${removed} invites removed from ${user.username}.`)] });
      }
      store.save();
    } else if (sub === 'reset') {
      if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply({
          embeds: [makeEmbed('error', 'Permission denied', 'You need Manage Server permission to reset invites.')],
        });
      }
      guildData.invites = {};
      store.save();
      await interaction.editReply({ embeds: [makeEmbed('success', 'Invites reset', 'All invite statistics have been cleared.')] });
    }
  },
};
