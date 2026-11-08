const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { autoBackupEnabled, createBackup, deleteBackup, findBackup, listBackups, restoreBackup, setAutoBackup, MAX_BACKUPS } = require('../backups');
const { fail, hasPerm, makeEmbed } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Snapshot and restore roles and channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription(`Save roles, categories and channels (max ${MAX_BACKUPS})`)
        .addStringOption((o) => o.setName('name').setDescription('Label for this backup').setMaxLength(50)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List saved backups'))
    .addSubcommand((sub) =>
      sub
        .setName('auto')
        .setDescription('Enable or disable the daily automatic backup')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Turn daily automatic backups on or off').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('restore')
        .setDescription('Recreate missing roles and channels from a backup. Nothing is deleted.')
        .addIntegerOption((o) => o.setName('id').setDescription('Backup number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a backup')
        .addIntegerOption((o) => o.setName('id').setDescription('Backup number').setRequired(true).setMinValue(1)),
    ),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.Administrator)) {
      return fail(interaction, 'You need the Administrator permission to use backups.');
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'create') {
      let backup;
      try {
        backup = createBackup(guild, interaction.options.getString('name') ?? `Backup ${new Date().toISOString().slice(0, 10)}`, interaction.user.id);
      } catch (err) {
        return fail(interaction, err.message);
      }
      return interaction.reply({
        embeds: [
          makeEmbed(
            'success',
            'Backup created',
            `**#${backup.id}:** ${backup.name}\n**Roles:** ${backup.roles.length}\n**Channels:** ${backup.channels.length}`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const items = listBackups(guild.id);
      const auto = autoBackupEnabled(guild.id) ? 'on' : 'off';
      const text = items.length
        ? items
            .map(
              (b) =>
                `**#${b.id}** ${b.name}${b.auto ? ' (automatic)' : ''}: ${b.roles.length} roles, ${b.channels.length} channels (<t:${Math.floor(b.createdAt / 1000)}:R>)`,
            )
            .join('\n')
        : 'No backup yet. Use `/backup create`.';
      return interaction.reply({
        embeds: [makeEmbed('info', 'Backups', `${text}\n\nDaily automatic backup: **${auto}**`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'auto') {
      const enabled = setAutoBackup(guild.id, interaction.options.getBoolean('enabled', true));
      return interaction.reply({
        embeds: [
          makeEmbed(
            'success',
            'Automatic backup updated',
            enabled
              ? 'A structural snapshot will be saved every 24 hours, replacing the previous automatic one.'
              : 'Daily automatic backups are now off. Existing backups are kept.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const id = interaction.options.getInteger('id', true);
    const backup = findBackup(guild.id, id);
    if (!backup) return fail(interaction, `No backup #${id}.`);

    if (sub === 'delete') {
      deleteBackup(guild.id, id);
      return interaction.reply({ embeds: [makeEmbed('success', 'Backup deleted', `Backup #${id} was deleted.`)], flags: MessageFlags.Ephemeral });
    }

    // restore
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = await restoreBackup(guild, backup);
    return interaction.editReply({
      embeds: [
        makeEmbed(
          'success',
          'Backup restored',
          `**Roles recreated:** ${report.roles}\n**Channels recreated:** ${report.channels}\n**Already present (skipped):** ${report.skipped}\n**Failed:** ${report.failed}\n\nNothing was deleted.`,
        ),
      ],
    });
  },
};
