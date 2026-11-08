const { MessageFlags, ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { endGiveaway, findGiveaway, giveawayConfig, parseDuration, rerollGiveaway, startGiveaway } = require('../giveaways');
const { fail, hasPerm, makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a giveaway')
        .addStringOption((option) => option.setName('prize').setDescription('What is being given away').setRequired(true))
        .addStringOption((option) =>
          option.setName('duration').setDescription('How long, e.g. 10m, 2h, 1d or 1h 30m').setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('winners').setDescription('Number of winners (1-20)').setMinValue(1).setMaxValue(20),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel to post in (defaults to this one)')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((option) => option.setName('required_role').setDescription('Members must have this role to enter'))
        .addIntegerOption((option) =>
          option.setName('min_level').setDescription('Minimum XP level required to enter').setMinValue(1).setMaxValue(500),
        )
        .addIntegerOption((option) =>
          option
            .setName('min_account_age')
            .setDescription('Minimum account age in days required to enter')
            .setMinValue(1)
            .setMaxValue(3650),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('End a giveaway now and pick winners')
        .addIntegerOption((option) => option.setName('id').setDescription('Giveaway number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Pick new winners for an ended giveaway')
        .addIntegerOption((option) => option.setName('id').setDescription('Giveaway number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List running giveaways')),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageMessages)) {
      return fail(interaction, 'You need the Manage Messages permission to use this command.');
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      const duration = interaction.options.getString('duration', true);
      const durationMs = parseDuration(duration);
      if (!durationMs) {
        return fail(interaction, 'Invalid duration. Use something like `10m`, `2h`, `1d` or `1h 30m` (1 minute to 30 days).');
      }

      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const requiredRole = interaction.options.getRole('required_role');
      const minLevel = interaction.options.getInteger('min_level');
      const minAccountAge = interaction.options.getInteger('min_account_age');
      const g = await startGiveaway(channel, {
        prize: interaction.options.getString('prize', true),
        durationMs,
        winners: interaction.options.getInteger('winners') ?? 1,
        hostId: interaction.user.id,
        requirements: {
          roleId: requiredRole?.id ?? null,
          minLevel: minLevel ?? null,
          minAccountAgeDays: minAccountAge ?? null,
        },
      });
      return interaction.reply({
        embeds: [makeEmbed('success', 'Giveaway started', `Giveaway #${g.id} is live in <#${channel.id}>.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const running = Object.values(giveawayConfig(interaction.guild.id).giveaways).filter((g) => !g.ended);
      const text = running.length
        ? running
            .map((g) => `**#${g.id}** ${g.prize}: ${g.entries.length} entries, ends <t:${Math.floor(g.endsAt / 1000)}:R>`)
            .join('\n')
        : 'No giveaway is running.';
      return interaction.reply({ embeds: [makeEmbed('info', 'Running giveaways', text)], flags: MessageFlags.Ephemeral });
    }

    const id = interaction.options.getInteger('id', true);
    const g = findGiveaway(interaction.guild.id, id);
    if (!g) return fail(interaction, `No giveaway #${id}.`);

    if (sub === 'end') {
      if (g.ended) return fail(interaction, `Giveaway #${id} has already ended.`);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await endGiveaway(interaction.guild, g);
      return interaction.editReply({ embeds: [makeEmbed('success', 'Giveaway ended', `Giveaway #${id} is over.`)] });
    }

    // reroll
    if (!g.ended) return fail(interaction, `Giveaway #${id} is still running. Use \`/giveaway end\` first.`);
    if (!g.entries.length) return fail(interaction, `Giveaway #${id} has no entries to pick from.`);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const winners = await rerollGiveaway(interaction.guild, g);
    return interaction.editReply({
      embeds: [
        makeEmbed(
          'success',
          'Giveaway rerolled',
          winners.length ? `New winners: ${winners.map((u) => `<@${u}>`).join(', ')}` : 'No winner could be picked.',
        ),
      ],
    });
  },
};
