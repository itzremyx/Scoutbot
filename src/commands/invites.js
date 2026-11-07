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
    .setDescription('Show and manage invite stats')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to look up (defaults to you)'))
    .addStringOption((opt) =>
      opt.setName('action')
        .setDescription('Manage invites (requires Manage Server)')
        .addChoices(
          { name: 'Add invites', value: 'add' },
          { name: 'Remove invites', value: 'remove' },
          { name: 'Reset all invites', value: 'reset' },
        ),
    )
    .addIntegerOption((opt) => opt.setName('count').setDescription('Number of invites to add/remove')),

  guildOnly: true,

  async execute(interaction) {
    const action = interaction.options.getString('action');
    const guildId = interaction.guild.id;
    const guildData = store.guild(guildId);

    // Without an action this is a plain lookup: /invites shows your own invites,
    // /invites user:@X shows a member's invites.
    if (!action) {
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
      return interaction.reply({ embeds: [embed] });
    }

    // Management actions (add / remove / reset) require Manage Server.
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        embeds: [makeEmbed('error', 'Permission denied', 'You need Manage Server permission to modify invites.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'reset') {
      guildData.invites = {};
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Invites reset', 'All invite statistics have been cleared.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const user = interaction.options.getUser('user');
    if (!user) {
      return interaction.reply({
        embeds: [makeEmbed('error', 'Member required', `Use the \`user\` option to pick who to ${action} invites for.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
    const count = interaction.options.getInteger('count') ?? 1;
    const entry = (guildData.invites ??= {})[user.id] ??= { regular: 0, leaves: 0 };
    if (action === 'add') {
      entry.regular += count;
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Invites added', `${count} invite${count === 1 ? '' : 's'} added to ${user.username}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (action === 'remove') {
      const newVal = Math.max(0, entry.regular - count);
      const removed = entry.regular - newVal;
      entry.regular = newVal;
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Invites removed', `${removed} invite${removed === 1 ? '' : 's'} removed from ${user.username}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
