const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const store = require('../storage');
const ai = require('../ai');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('personality')
    .setDescription("View or change the bot's personality")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set the personality, e.g. "You are nonchalant, hate caps and have depressive vibes"')
        .addStringOption((option) =>
          option.setName('description').setDescription('How the bot should act').setRequired(true).setMaxLength(1500),
        ),
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the current personality'))
    .addSubcommand((sub) => sub.setName('reset').setDescription('Restore the default personality')),

  guildOnly: true,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      return interaction.reply({
        embeds: [makeEmbed('info', 'Current personality', truncate(ai.getPersonality(), 4000))],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to change the personality.');
    }

    if (sub === 'set') {
      const description = interaction.options.getString('description', true);
      store.data.settings.personality = description;
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Personality updated', truncate(description, 4000))],
      });
    }

    delete store.data.settings.personality;
    store.save();
    return interaction.reply({
      embeds: [makeEmbed('success', 'Personality reset', truncate(config.defaultPersonality, 4000))],
    });
  },
};
