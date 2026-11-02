const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { VIEW_PERMISSION, activeWarningFor, labelOf, modlogConfig, warnCount } = require('../modlog');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

const NO_PERMISSION = 'You need the Moderate Members permission to read moderation history.';
const PER_PAGE = 8;

// One line of history, newest first. Entries pointing at a warning that was removed since
// are marked, so the history stays accurate after an /unwarn.
function entryLine(guildId, entry) {
  const label = labelOf(entry);
  const stillActive = activeWarningFor(guildId, entry);
  const suffix =
    entry.meta?.warningId !== undefined && !stillActive && ['warn', 'automod'].includes(entry.action)
      ? ' *(since removed)*'
      : '';
  const by = entry.moderatorId ? `<@${entry.moderatorId}>` : 'auto-mod';
  const reason = entry.reason ? `\n${entry.reason}` : '';
  return `**#${entry.id}** • ${label}${suffix} • <t:${Math.floor(entry.at / 1000)}:d>\nby ${by}${reason}`;
}

const modlog = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Show the moderation history of a member: warnings, kicks, bans, timeouts')
    .setDefaultMemberPermissions(VIEW_PERMISSION)
    .addUserOption((option) => option.setName('user').setDescription('Member to inspect (defaults to you)').setRequired(false))
    .addIntegerOption((option) => option.setName('page').setDescription('Page of the history').setMinValue(1)),

  async execute(interaction) {
    const { guild } = interaction;
    const user = interaction.options.getUser('user') ?? interaction.user;
    // Reading your own history is free; anyone else's needs the moderator permission.
    if (user.id !== interaction.user.id && !hasPerm(interaction, VIEW_PERMISSION)) {
      return fail(interaction, NO_PERMISSION);
    }

    const entries = modlogConfig(guild.id).entries.filter((e) => e.userId === user.id).reverse();
    const total = entries.length;
    const active = warnCount(guild.id, user.id);

    if (!total) {
      return interaction.reply({
        embeds: [makeEmbed('success', 'No history', `**${user.tag}** has no recorded moderation history.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const pages = Math.ceil(total / PER_PAGE);
    const page = Math.min(interaction.options.getInteger('page') ?? 1, pages);
    const slice = entries.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    const lines = slice.map((entry) => entryLine(guild.id, entry));

    const embed = makeEmbed(
      'warn',
      `📜 Moderation history — ${user.tag}`,
      truncate(lines.join('\n\n'), 4000),
    );
    embed.setFooter({ text: `${total} record(s) • ${active} active warning(s) • page ${page}/${pages}` });
    embed.setThumbnail(user.displayAvatarURL());

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

module.exports = { modlog };
