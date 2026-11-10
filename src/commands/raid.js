const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { fail, hasPerm, makeEmbed } = require('../utils');
const { addModlogEntry } = require('../modlog');
const raid = require('../raid');

const DEFAULT_DURATION_MINUTES = 30;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Toggle raid protection and tune the automatic join-rate detection')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addBooleanOption((option) =>
      option
        .setName('enabled')
        .setDescription('Turn raid protection on (true) or off (false); default toggles')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('duration')
        .setDescription('Minutes each joining member is timed out (1-1440, default 30)')
        .setMinValue(1)
        .setMaxValue(raid.MAX_TIMEOUT_MINUTES),
    )
    .addBooleanOption((option) =>
      option
        .setName('auto')
        .setDescription('Turn raid mode on automatically when too many members join at once')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('joins')
        .setDescription('Automatic trigger: number of joins in the window (2-100, default 8)')
        .setMinValue(2)
        .setMaxValue(100),
    )
    .addIntegerOption((option) =>
      option
        .setName('window')
        .setDescription('Automatic trigger: window in seconds (3-600, default 20)')
        .setMinValue(3)
        .setMaxValue(raid.MAX_WINDOW_SECONDS),
    )
    .addIntegerOption((option) =>
      option
        .setName('min_age')
        .setDescription('During a raid, accounts younger than this many hours are kicked (0-720, default 24)')
        .setMinValue(0)
        .setMaxValue(raid.MAX_ACCOUNT_AGE_HOURS),
    )
    .addBooleanOption((option) =>
      option
        .setName('kick_young')
        .setDescription('During a raid, kick very young accounts instead of only timing them out')
        .setRequired(false),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
      return fail(interaction, 'You need the Moderate Members permission to do this.');
    }

    const explicit = interaction.options.getBoolean('enabled');
    const duration = interaction.options.getInteger('duration');
    const auto = interaction.options.getBoolean('auto');
    const joins = interaction.options.getInteger('joins');
    const window = interaction.options.getInteger('window');
    const minAge = interaction.options.getInteger('min_age');
    const kickYoung = interaction.options.getBoolean('kick_young');

    const patch = {};
    if (duration !== null) patch.timeoutMinutes = duration;
    if (auto !== null) patch.autoEnabled = auto;
    if (joins !== null) patch.joinThreshold = joins;
    if (window !== null) patch.joinWindowSeconds = window;
    if (minAge !== null) patch.minAccountAgeHours = minAge;
    if (kickYoung !== null) patch.kickYoung = kickYoung;

    const turningOn = explicit === null ? !raid.isRaidActive(interaction.guild.id) : explicit;
    patch.enabled = turningOn;

    const config = raid.setRaid(interaction.guild.id, patch, {
      record: true,
      actorId: interaction.user.id,
      detail: `Changed with /raid by ${interaction.user.username}.`,
    });

    const note = duration === null && turningOn ? ` Protection ends automatically <t:${Math.floor(config.endsAt / 1000)}:R>.` : '';

    addModlogEntry(interaction.guild.id, {
      userId: interaction.user.id,
      action: 'raid',
      reason: turningOn
        ? `Raid protection on: ${config.timeoutMinutes} min timeout, auto at ${config.joinThreshold} joins/${config.joinWindowSeconds}s.`
        : 'Raid protection off.',
      moderatorId: interaction.user.id,
    });

    const lines = [
      `Members who join are timed out for **${config.timeoutMinutes} min**${note}`,
      `Automatic trigger: **${config.autoEnabled ? 'on' : 'off'}** (${config.joinThreshold} joins in ${config.joinWindowSeconds}s)`,
      `Young accounts: ${config.kickYoung ? `kicked when younger than ${config.minAccountAgeHours}h` : `only timed out (threshold ${config.minAccountAgeHours}h)`}`,
    ];

    return interaction.reply({
      embeds: [
        makeEmbed(turningOn ? 'warn' : 'success', turningOn ? 'Raid mode on' : 'Raid mode off', lines.join('\n')),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
