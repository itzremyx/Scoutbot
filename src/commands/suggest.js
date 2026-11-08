const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('../config');
const { addSuggestion, getSuggestion, setSuggestionStatus } = require('../suggestions');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

const STAFF = PermissionFlagsBits.ManageMessages;
const STATUS_STYLE = {
  accepted: { kind: 'success', emoji: '✅', label: 'Accepted' },
  declined: { kind: 'error', emoji: '❌', label: 'Declined' },
  duplicate: { kind: 'warn', emoji: '🔁', label: 'Duplicate' },
};

function voteButton() {
  return new ButtonBuilder()
    .setCustomId('suggestion:vote')
    .setLabel('Vote on the first message')
    .setEmoji('🗳️')
    .setStyle(ButtonStyle.Secondary);
}

const suggest = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Post an idea in the suggestions forum')
    .addStringOption((option) =>
      option.setName('title').setDescription('Short title for your suggestion').setRequired(true).setMaxLength(100),
    )
    .addStringOption((option) =>
      option.setName('details').setDescription('Explain your idea').setRequired(true).setMaxLength(1800),
    )
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Category tag')
        .addChoices(
          { name: 'Website', value: 'Website' },
          { name: 'Models', value: 'Models' },
          { name: 'Applications', value: 'Applications' },
        ),
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const forum = await interaction.client.channels.fetch(config.suggestionChannelId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      return interaction.editReply({ embeds: [makeEmbed('error', 'Suggestions unavailable', 'The suggestions forum channel is not set up correctly.')] });
    }

    const title = interaction.options.getString('title', true).trim();
    const details = interaction.options.getString('details', true).trim();
    const category = interaction.options.getString('category');
    const tag = category
      ? forum.availableTags.find((available) => available.name.toLowerCase() === category.toLowerCase())
      : null;

    const thread = await forum.threads
      .create({
        name: truncate(title, 100),
        appliedTags: tag ? [tag.id] : [],
        message: {
          content: `**Suggestion**\n${details}`,
          allowedMentions: { parse: [] },
        },
        reason: `Suggestion by ${interaction.user.username}`,
      })
      .catch((err) => {
        console.error('Suggestion creation failed:', err.message);
        return null;
      });

    if (!thread) {
      return interaction.editReply({ embeds: [makeEmbed('error', 'Suggestion failed', 'I could not create the forum post. Check my permissions in the suggestions channel.')] });
    }

    // The first message carries the votes, so the two reactions are added by the bot.
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) {
      await starter.react('👍').catch(() => {});
      await starter.react('👎').catch(() => {});
    }

    const callout = makeEmbed(
      'info',
      'Like this idea?',
      'Vote with 👍 or 👎 on the first message.\n\nStaff: `/accept` · `/decline` · `/duplicate` inside this post',
    );
    const row = new ActionRowBuilder().addComponents(voteButton());
    await thread.send({ embeds: [callout], components: [row] }).catch(() => {});

    addSuggestion(interaction.guild.id, thread.id, {
      authorId: interaction.user.id,
      title,
      tag: category ?? null,
    });

    return interaction.editReply({
      embeds: [makeEmbed('success', 'Suggestion posted', `Your idea is live: ${thread}`)],
    });
  },
};

async function voteCounts(thread) {
  const starter = await thread.fetchStarterMessage({ force: true }).catch(() => null);
  const count = (emoji) => Math.max(0, (starter?.reactions?.cache?.get(emoji)?.count ?? 0) - 1);
  return { up: count('👍'), down: count('👎') };
}

function staffCommand(name, status) {
  const style = STATUS_STYLE[status];
  return {
    guildOnly: true,
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(`${style.label} a suggestion (staff)`)
      .setDefaultMemberPermissions(STAFF)
      .addStringOption((option) => option.setName('note').setDescription('Optional note shown in the post').setMaxLength(500)),

    async execute(interaction) {
      if (!hasPerm(interaction, STAFF)) return fail(interaction, 'You need Manage Messages to decide suggestions.');
      const suggestion = getSuggestion(interaction.guild.id, interaction.channelId);
      if (!suggestion) return fail(interaction, 'Use this command inside a suggestion post.');
      if (suggestion.status && suggestion.status !== 'open') {
        return fail(interaction, `This suggestion was already marked **${suggestion.status}**.`);
      }

      await interaction.deferReply();
      const note = interaction.options.getString('note');
      const votes = await voteCounts(interaction.channel);
      setSuggestionStatus(interaction.guild.id, interaction.channelId, status, interaction.user.id, note);

      const description = [
        `**Suggestion:** ${truncate(suggestion.title, 300)}`,
        `**Votes:** 👍 ${votes.up} · 👎 ${votes.down}`,
        `**Decided by:** <@${interaction.user.id}>`,
        ...(note ? [`\n${note}`] : []),
      ].join('\n');

      return interaction.editReply({
        embeds: [makeEmbed(style.kind, `${style.emoji} Suggestion ${style.label.toLowerCase()}`, description)],
      });
    },
  };
}

const accept = staffCommand('accept', 'accepted');
const decline = staffCommand('decline', 'declined');
const duplicate = staffCommand('duplicate', 'duplicate');

module.exports = { suggest, accept, decline, duplicate };
