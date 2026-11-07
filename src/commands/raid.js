const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { fail, hasPerm, makeEmbed } = require('../utils');
const { addModlogEntry } = require('../modlog');
const raid = require('../raid');

const DEFAULT_DURATION_MINUTES = 30;
const MAX_DURATION_MINUTES = 1440;

// Turn raid protection on (with a duration) or off. While on, every member who joins the server
// is automatically timed out for the configured number of minutes.
async function setRaid(interaction, turningOn, durationMinutes = null) {
  const config = raid.raidConfig(interaction.guild.id);
  config.enabled = turningOn;
  if (durationMinutes) config.timeoutMinutes = Math.min(MAX_DURATION_MINUTES, Math.max(1, durationMinutes));
  config.endsAt = turningOn ? Date.now() + config.timeoutMinutes * 60_000 : null;
  store.save();

  const detail = turningOn
    ? `Raid protection on — members who join are timed out ${config.timeoutMinutes} min (until <t:${Math.floor(config.endsAt / 1000)}:R>).`
    : 'Raid protection off.';
  addModlogEntry(interaction.guild.id, {
    userId: interaction.user.id,
    action: 'raid',
    reason: detail,
    moderatorId: interaction.user.id,
  });
  return config;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Toggle raid protection: auto-timeout every member who joins the server')
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
        .setMaxValue(MAX_DURATION_MINUTES),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ModerateMembers)) {
      return fail(interaction, 'You need the Moderate Members permission to do this.');
    }

    const explicit = interaction.options.getBoolean('enabled');
    const turningOn = explicit === null ? !raid.raidConfig(interaction.guild.id).enabled : explicit;

    if (!turningOn) {
      const config = await setRaid(interaction, false);
      await interaction.reply({
        embeds: [makeEmbed('success', '🛡️ Raid mode off', 'New members can join again.')] ,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const duration = interaction.options.getInteger('duration') ?? DEFAULT_DURATION_MINUTES;
    const config = await setRaid(interaction, true, duration);
    return interaction.reply({
      embeds: [
        makeEmbed(
          'warn',
          '🛡️ Raid mode on',
          `Every member who joins is automatically timed out for **${config.timeoutMinutes} min**.\nProtection ends automatically: <t:${Math.floor(config.endsAt / 1000)}:R>.`,
        ),
      ],
    });
  },
};
