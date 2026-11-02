const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { levelsConfig, progressOf, setXp, totalXp } = require('../levels');
const { fail, hasPerm, makeEmbed } = require('../utils');

const MAX_XP = 1_000_000_000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Manage a member’s XP')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add XP to a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('XP to add').setRequired(true).setMinValue(1).setMaxValue(MAX_XP)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove XP from a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('XP to remove').setRequired(true).setMinValue(1).setMaxValue(MAX_XP)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set a member’s XP to an exact value')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('New XP total').setRequired(true).setMinValue(0).setMaxValue(MAX_XP)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('level')
        .setDescription('Set a member to the start of a level')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('value').setDescription('Level to set').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Reset a member’s XP to 0')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    ),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to use this command.');
    }

    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user', true);
    const guildId = interaction.guild.id;
    const current = levelsConfig(guildId).users[user.id]?.xp ?? 0;

    let next;
    if (sub === 'add') next = current + interaction.options.getInteger('amount', true);
    else if (sub === 'remove') next = current - interaction.options.getInteger('amount', true);
    else if (sub === 'set') next = interaction.options.getInteger('amount', true);
    else if (sub === 'level') next = totalXp(interaction.options.getInteger('value', true));
    else next = 0;

    const saved = setXp(guildId, user.id, Math.min(MAX_XP, next));
    const { level } = progressOf(saved);
    return interaction.reply({
      embeds: [
        makeEmbed(
          'success',
          'XP updated',
          `**Member:** <@${user.id}>\n**XP:** ${current} → ${saved}\n**Level:** ${progressOf(current).level} → ${level}`,
        ),
      ],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  },
};

