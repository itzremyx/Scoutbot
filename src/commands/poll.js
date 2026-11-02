const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

const MAX_ANSWERS = 10;
const MAX_DURATION_H = 32 * 24; // Discord's own limit is 32 days.

// Native Discord poll (voters click the answers in the message). Needs no scheduler: Discord ends
// it on its own when the duration runs out.
const poll = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a poll with click-to-vote answers')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) =>
      option.setName('question').setDescription('The question to ask').setRequired(true).setMaxLength(300),
    )
    .addStringOption((option) =>
      option
        .setName('answers')
        .setDescription(`Answer choices, separated by | (2 to ${MAX_ANSWERS}, e.g. "Yes | No")`)
        .setRequired(true)
        .setMaxLength(550),
    )
    .addStringOption((option) =>
      option.setName('duration').setDescription('How long the poll stays open, like 1h or 1d (default 24h)').setMaxLength(20),
    )
    .addBooleanOption((option) =>
      option.setName('multi').setDescription('Let members vote for several answers (default: no)'),
    )
    .addChannelOption((option) => option.setName('channel').setDescription('Post it in another channel (default: here)')),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageMessages)) {
      return fail(interaction, 'You need Manage Messages to create a poll.');
    }

    const question = interaction.options.getString('question', true).trim();
    const answers = interaction.options
      .getString('answers', true)
      .split('|')
      .map((text) => text.trim())
      .filter(Boolean);
    const unique = [...new Set(answers.map((text) => text.toLowerCase()))];

    if (answers.length < 2 || answers.length > MAX_ANSWERS) {
      return fail(interaction, `Give between 2 and ${MAX_ANSWERS} answers, separated by | (e.g. "Yes | No").`);
    }
    if (unique.length !== answers.length) return fail(interaction, 'The answers must all be different.');
    if (answers.some((text) => text.length > 100)) {
      return fail(interaction, 'Each answer must be 100 characters or shorter.');
    }

    // Discord takes the duration in hours; 24h when nothing was given.
    let durationHours = 24;
    const durationInput = interaction.options.getString('duration');
    if (durationInput) {
      const raw = durationInput.trim().toLowerCase();
      const match = raw.match(/^(\d+)\s*(h|d)?$/);
      durationHours = match ? Number(match[1]) * (match[2] === 'd' ? 24 : 1) : NaN;
      if (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > MAX_DURATION_H) {
        return fail(interaction, 'The duration must be a whole number of hours or days, like `1h`, `12h` or `2d` (max 32 days).');
      }
    }

    const target =
      interaction.options.getChannel('channel') ?? interaction.channel;
    if (target.id !== interaction.channelId && !target.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      return fail(interaction, `I cannot send messages in ${target}.`);
    }

    const embed = makeEmbed('info', '📊 Poll', question);
    embed.setFooter({ text: `Opened by ${interaction.user.username} • closes in ${durationHours}h` });

    await target.send({
      embeds: [embed],
      poll: {
        question: { text: truncate(question, 300) },
        answers: answers.map((text) => ({ text })),
        duration: durationHours,
        allowMultiselect: interaction.options.getBoolean('multi') ?? false,
      },
    });

    // Posting somewhere else is worth telling the caller about.
    if (target.id !== interaction.channelId) {
      return interaction.reply({
        embeds: [makeEmbed('success', '📊 Poll created', `Your poll is up in ${target}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      embeds: [makeEmbed('success', '📊 Poll created', `The poll is live above (open ${durationHours}h).`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

module.exports = { poll };
