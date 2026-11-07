const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const snipe = require('../snipe');
const { fail, hasPerm, makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Show the last deleted message in this channel')
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('show').setDescription('Show the sniped message'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Clear the sniped message (managers)')),

  guildOnly: true,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'clear') {
      if (!hasPerm(interaction, PermissionFlagsBits.ManageMessages)) {
        return fail(interaction, 'You need the Manage Messages permission to clear the snipe.');
      }
      if (!snipe.clear(interaction.channel.id)) {
        return fail(interaction, 'There is no sniped message in this channel yet.');
      }
      return interaction.reply({ embeds: [makeEmbed('success', 'Snipe cleared', 'The sniped message for this channel has been forgotten.')], flags: MessageFlags.Ephemeral });
    }

    const captured = snipe.peek(interaction.channel.id);
    if (!captured) {
      return fail(interaction, 'No message has been deleted in this channel since I started watching.');
    }

    const author = captured.author;
    const age = Math.max(0, Math.round((Date.now() - captured.at) / 1000));
    const body = [
      captured.content,
      ...captured.attachments.map((file) => `[attachment: ${file.name}](${file.url})`),
      ...captured.embeds.filter((embed) => embed.url).map((embed) => `[embed](${embed.url})`),
    ].filter(Boolean).join('\n');

    const embed = makeEmbed('info', 'Deleted message', body || '*The message had no text or attachments.*')
      .setAuthor({ name: `${author.username ?? 'Unknown'}${author.tag ? ` (${author.tag})` : ''}`, iconURL: null })
      .addFields(
        { name: 'Deleted', value: `${age}s ago`, inline: true },
        { name: 'Channel', value: `${interaction.channel}`, inline: true },
      );
    if (captured.url) embed.setFooter({ text: captured.url });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.None });
  },
};
