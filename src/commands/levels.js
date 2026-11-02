const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { levelsConfig } = require('../levels');
const { THEME_CHOICES } = require('../rankcard');
const { fail, hasPerm, makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('levels')
    .setDescription('Configure the level system')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the level system settings'))
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Turn XP gain on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('theme')
        .setDescription('Pick the model theme of the rank card')
        .addStringOption((o) =>
          o
            .setName('model')
            .setDescription('Theme')
            .setRequired(true)
            .addChoices(...THEME_CHOICES),
        ),
    ),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to use this command.');
    }

    const cfg = levelsConfig(interaction.guild.id);
    const sub = interaction.options.getSubcommand();

    if (sub === 'toggle') {
      cfg.enabled = interaction.options.getBoolean('enabled', true);
      store.save();
    } else if (sub === 'theme') {
      cfg.theme = interaction.options.getString('model', true);
      store.save();
    }

    const theme = THEME_CHOICES.find((t) => t.value === cfg.theme)?.name ?? cfg.theme;
    const text = [
      `**XP gain:** ${cfg.enabled ? 'on' : 'off'}`,
      `**Card theme:** ${theme}`,
      `**Members with XP:** ${Object.keys(cfg.users).length}`,
      `**Level-up messages** are deleted after 2 minutes.`,
    ].join('\n');
    return interaction.reply({ embeds: [makeEmbed('info', 'Levels', text)], flags: MessageFlags.Ephemeral });
  },
};
