const { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { fail, hasPerm, makeEmbed } = require('../utils');
const stickies = require('../stickies');
const { post } = require('../logs');

const EMBED_CHOICES = [
  { name: 'Blue', value: 'info' },
  { name: 'Green', value: 'success' },
  { name: 'Yellow', value: 'warn' },
  { name: 'Red', value: 'error' },
];

const options = (sub) =>
  sub
    .addStringOption((option) => option.setName('text').setDescription('The message to keep at the bottom (max 900 characters)').setRequired(true).setMaxLength(900))
    .addIntegerOption((option) =>
      option.setName('every').setDescription('Re-post after this many messages (1 = every message, default 1)').setMinValue(1).setMaxValue(50),
    )
    .addStringOption((option) => option.setName('style').setDescription('Plain text (default) or an embed').addChoices(...EMBED_CHOICES))
    .addChannelOption((option) => option.setName('channel').setDescription('Another channel to pin it in (default: here)').addChannelTypes(ChannelType.GuildText));

async function send(interaction, embed, description) {
  return interaction.reply({ embeds: [makeEmbed(embed, 'Sticky message', description)], flags: MessageFlags.Ephemeral });
}

module.exports = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Keep a message pinned at the bottom of a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) => options(sub.setName('set').setDescription('Post a message that always returns to the bottom')))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop the sticky in a channel')
        .addChannelOption((option) => option.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('debug')
        .setDescription('Show the message ids behind the stickies of this server (not shown in /logs)')
        .addChannelOption((option) => option.setName('channel').setDescription('Only this channel').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Show every sticky in this server'),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageMessages)) {
      return fail(interaction, 'You need the Manage Messages permission to use this command.');
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ok = await stickies.set(
        interaction.client,
        interaction.guild.id,
        channel.id,
        interaction.options.getString('text', true),
        {
          interval: interaction.options.getInteger('every') ?? 1,
          embed: interaction.options.getString('style') ?? null,
        },
      );
      if (!ok) return interaction.editReply({ embeds: [makeEmbed('error', 'Sticky message', `I could not post in ${channel}. Check my permissions there.`)] });

      post(interaction.guild, 'info', 'Sticky set', [
        ['Channel', `${channel}`, true],
        ['Moderator', `<@${interaction.user.id}>`, true],
        ['Content', interaction.options.getString('text', true)],
      ]);
      return interaction.editReply({
        embeds: [
          makeEmbed(
            'success',
            'Sticky message',
            `I will keep a message at the bottom of ${channel}${
              (interaction.options.getInteger('every') ?? 1) > 1 ? ` after every ${interaction.options.getInteger('every')} messages` : ''
            }.`,
          ),
        ],
      });
    }

    if (sub === 'remove') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const removed = await stickies.remove(interaction.client, interaction.guild.id, channel.id);
      if (!removed) return send(interaction, 'info', `There is no sticky in ${channel}.`);
      post(interaction.guild, 'info', 'Sticky removed', [
        ['Channel', `${channel}`, true],
        ['Moderator', `<@${interaction.user.id}>`, true],
      ]);
      return send(interaction, 'success', `The sticky in ${channel} was removed.`);
    }

    if (sub === 'debug') {
      const channel = interaction.options.getChannel('channel');
      const data = stickies.details(interaction.guild.id);
      const body = data ? (channel ? data.split('\n').filter((line) => line.startsWith(`<#${channel.id}>`)).join('\n') || 'Nothing for that channel.' : data) : 'No sticky in this server.';
      return send(interaction, 'info', `**Sticky internals**\n${body}\n\nRe-posts are not written to the log channel on purpose.`);
    }

    const list = stickies.list(interaction.guild.id);
    if (!list) return send(interaction, 'info', 'This server has no sticky messages. Use `/sticky set` to add one.');
    return send(interaction, 'info', `**Active stickies**\n${list}`);
  },
};