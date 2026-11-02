const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
const store = require('../storage');
const { automodConfig, MAX_WORDS, WORD_MAX_LENGTH } = require('../automod');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

const MAX_TIMEOUT_MINUTES = 4032; // Discord's limit: 28 days

function statusEmbed(guildId) {
  const config = automodConfig(guildId);
  const words = config.words.length
    ? config.words.map((w) => `**${w}**`).join(', ')
    : '_none yet_';
  return makeEmbed(
    config.enabled ? 'success' : 'info',
    `Auto-moderation is **${config.enabled ? 'on' : 'off'}**`,
    [
      `**Blocked words** (${config.words.length}/${MAX_WORDS})`,
      truncate(words, 1000),
      '',
      `**Escalation:** warning at each hit, timeout of **${config.timeoutMinutes} min** from **warning ${config.timeoutAt}**.`,
      'Moderators with Manage Messages are never caught by the filter.',
    ].join('\n'),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure automatic moderation (blocked words and strike timeouts)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current auto-moderation settings'))
    .addSubcommand((sub) => sub.setName('toggle').setDescription('Turn auto-moderation on or off'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a blocked word or phrase')
        .addStringOption((option) =>
          option.setName('word').setDescription('Word or phrase to block').setRequired(true).setMaxLength(WORD_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a blocked word')
        .addStringOption((option) =>
          option.setName('word').setDescription('Word to unblock (leave empty to pick from a list)').setMaxLength(WORD_MAX_LENGTH),
        ),
    )
    .addSubcommand((sub) => sub.setName('words').setDescription('List the blocked words'))
    .addSubcommand((sub) =>
      sub
        .setName('timeout')
        .setDescription('Set when a member gets timed out')
        .addIntegerOption((option) =>
          option.setName('at').setDescription('Warning number that triggers the timeout').setRequired(true).setMinValue(1).setMaxValue(10),
        )
        .addIntegerOption((option) =>
          option.setName('minutes').setDescription('Timeout length in minutes').setRequired(true).setMinValue(1).setMaxValue(MAX_TIMEOUT_MINUTES),
        ),
    ),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to use this command.');
    }

    const config = automodConfig(interaction.guild.id);
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      return interaction.reply({ embeds: [statusEmbed(interaction.guild.id)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'toggle') {
      config.enabled = !config.enabled;
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Auto-moderation updated', `Auto-moderation is now **${config.enabled ? 'on' : 'off'}**.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'add') {
      const word = interaction.options.getString('word', true).trim().toLowerCase();
      if (config.words.includes(word)) return fail(interaction, `\`${word}\` is already blocked.`);
      if (config.words.length >= MAX_WORDS) return fail(interaction, `The list is full (${MAX_WORDS} words). Remove one first.`);
      config.words.push(word);
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Word blocked', `Messages containing **${word}** now receive a warning.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'remove') {
      const word = interaction.options.getString('word')?.trim().toLowerCase();
      if (word === undefined || word === '') {
        if (!config.words.length) return fail(interaction, 'No blocked words yet.');
        const menu = new StringSelectMenuBuilder()
          .setCustomId('automod:remove')
          .setPlaceholder('Select a word to unblock')
          .addOptions(
            config.words.slice(0, 25).map((w) => ({ label: truncate(w, 100), value: w })),
          );
        return interaction.reply({
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!config.words.includes(word)) return fail(interaction, `\`${word}\` is not blocked.`);
      config.words = config.words.filter((w) => w !== word);
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Word unblocked', `**${word}** is allowed again.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'words') {
      if (!config.words.length) return fail(interaction, 'No blocked words yet.');
      return interaction.reply({
        embeds: [
          makeEmbed(
            'info',
            `Blocked words (${config.words.length})`,
            truncate(config.words.map((w) => `**${w}**`).join(', '), 3900),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'timeout') {
      config.timeoutAt = interaction.options.getInteger('at', true);
      config.timeoutMinutes = interaction.options.getInteger('minutes', true);
      store.save();
      return interaction.reply({
        embeds: [
          makeEmbed(
            'success',
            'Escalation updated',
            `Members are now timed out **${config.timeoutMinutes} min** when they reach warning **${config.timeoutAt}**.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    return fail(interaction, 'Unknown subcommand.');
  },
};

// Dropdown of the /automod remove menu, handled like the other components.
function handleRemoveSelect(interaction) {
  const config = automodConfig(interaction.guild.id);
  const word = interaction.values[0];
  if (!config.words.includes(word)) {
    return interaction.update({ content: `**${word}** is no longer blocked.`, embeds: [], components: [] });
  }
  config.words = config.words.filter((w) => w !== word);
  store.save();
  return interaction.update({ content: `✅ **${word}** is allowed again.`, embeds: [], components: [] });
}

module.exports.handleRemoveSelect = handleRemoveSelect;