const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { submitAppeal, listAppeals } = require('../appeals');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

module.exports = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('appeal')
    .setDescription('Appeal a ban, timeout or temporary punishment')
    .addSubcommand((sub) =>
      sub
        .setName('submit')
        .setDescription('Send an appeal to the staff')
        .addStringOption((option) =>
          option
            .setName('reason')
            .setDescription('Why should the punishment be lifted?')
            .setRequired(true)
            .setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List open appeals (staff only)')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild) && !hasPerm(interaction, PermissionFlagsBits.BanMembers)) {
        return fail(interaction, 'You need Manage Server or Ban Members permission to list appeals.');
      }
      const items = listAppeals(interaction.guild.id);
      const text = items.length
        ? items
            .map(
              (item) =>
                `**#${item.id}** <@${item.userId}> — <t:${Math.floor(item.createdAt / 1000)}:R>\n${truncate(item.reason, 200)}`,
            )
            .join('\n\n')
        : 'No open appeal right now.';
      return interaction.reply({
        embeds: [makeEmbed('info', 'Open appeals', truncate(text, 4000))],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await submitAppeal(interaction.client, interaction.user, interaction.options.getString('reason', true), {
      guildId: interaction.guild.id,
      source: 'command',
    });
    if (result.error) return fail(interaction, result.error);
    return interaction.editReply({ embeds: [makeEmbed('success', 'Appeal submitted', result.message)] });
  },
};
