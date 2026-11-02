const {
  MessageFlags,
  ActionRowBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const store = require('../storage');
const { checkTarget, dmUser, fail, fetchMember, hasPerm, makeEmbed, sendLog, truncate } = require('../utils');

const MOD_PERMISSION = PermissionFlagsBits.ModerateMembers;
const NO_PERMISSION = 'You need the Moderate Members permission to use this.';

// Shows the active warnings of a member, with a dropdown to remove one of them.
function buildWarningsView(guildId, userId) {
  const warnings = store.guild(guildId).warnings[userId] ?? [];
  if (!warnings.length) {
    return { embeds: [makeEmbed('success', 'No warnings', `<@${userId}> has no active warnings.`)], components: [] };
  }

  const lines = warnings.map(
    (w) => `**#${w.id}** • <t:${Math.floor(w.createdAt / 1000)}:d> by <@${w.moderatorId}>\n${w.reason}`,
  );
  const embed = makeEmbed(
    'warn',
    `⚠️ ${warnings.length} active warning(s)`,
    truncate(`**Member:** <@${userId}>\n\n${lines.join('\n\n')}`, 4000),
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`unwarn:select:${userId}`)
    .setPlaceholder('Select a warning to remove')
    .addOptions(
      warnings.slice(0, 25).map((w) => ({
        label: truncate(`#${w.id} — ${w.reason}`, 100),
        value: String(w.id),
      })),
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function removeWarning(guildId, userId, warningId) {
  const settings = store.guild(guildId);
  const list = settings.warnings[userId] ?? [];
  const index = list.findIndex((w) => w.id === warningId);
  if (index === -1) return null;

  const [removed] = list.splice(index, 1);
  if (!list.length) delete settings.warnings[userId];
  store.save();
  return removed;
}

function logWarningRemoval(interaction, userId, warningId) {
  return sendLog(interaction.guild, {
    embeds: [
      makeEmbed(
        'success',
        'Warning removed',
        `**Member:** <@${userId}>\n**Warning:** #${warningId}\n**Moderator:** <@${interaction.user.id}>`,
      ),
    ],
  });
}

async function handleUnwarnSelect(interaction) {
  if (!hasPerm(interaction, MOD_PERMISSION)) {
    return interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
  }

  const userId = interaction.customId.split(':')[2];
  const warningId = Number(interaction.values[0]);
  const removed = removeWarning(interaction.guild.id, userId, warningId);
  if (!removed) {
    return interaction.update({ ...buildWarningsView(interaction.guild.id, userId), content: 'That warning no longer exists.' });
  }

  await logWarningRemoval(interaction, userId, warningId);
  return interaction.update({
    ...buildWarningsView(interaction.guild.id, userId),
    content: `✅ Removed warning #${warningId}.`,
  });
}

const warn = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning to a member')
    .setDefaultMemberPermissions(MOD_PERMISSION)
    .addUserOption((option) => option.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why are they being warned?').setRequired(true).setMaxLength(500),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, MOD_PERMISSION)) return fail(interaction, NO_PERMISSION);

    const { guild } = interaction;
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);

    const member = await fetchMember(guild, user.id);
    if (member) {
      const error = await checkTarget(guild, interaction.user.id, member);
      if (error) return fail(interaction, error);
    }

    const settings = store.guild(guild.id);
    const warning = { id: settings.nextWarningId++, reason, moderatorId: interaction.user.id, createdAt: Date.now() };
    (settings.warnings[user.id] ??= []).push(warning);
    store.save();

    await dmUser(user, makeEmbed('warn', `You received a warning in ${guild.name}`, `**Reason:** ${reason}`));
    await sendLog(guild, {
      embeds: [
        makeEmbed(
          'warn',
          'Member warned',
          `**Member:** <@${user.id}>\n**Warning:** #${warning.id}\n**Moderator:** <@${interaction.user.id}>\n**Reason:** ${reason}`,
        ),
      ],
    });

    return interaction.reply({
      embeds: [
        makeEmbed(
          'warn',
          'Warning issued',
          `<@${user.id}> has been warned (warning #${warning.id}). Active warnings: ${settings.warnings[user.id].length}.\n**Reason:** ${reason}`,
        ),
      ],
    });
  },

};

const unwarn = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Remove a warning from a member')
    .setDefaultMemberPermissions(MOD_PERMISSION)
    .addUserOption((option) => option.setName('user').setDescription('Member to unwarn').setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName('warning_id')
        .setDescription('ID of the warning to remove (leave empty to pick from a list)')
        .setMinValue(1),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, MOD_PERMISSION)) return fail(interaction, NO_PERMISSION);

    const user = interaction.options.getUser('user', true);
    const warningId = interaction.options.getInteger('warning_id');

    if (warningId === null) {
      return interaction.reply({ ...buildWarningsView(interaction.guild.id, user.id), flags: MessageFlags.Ephemeral });
    }

    const removed = removeWarning(interaction.guild.id, user.id, warningId);
    if (!removed) return fail(interaction, `<@${user.id}> has no warning #${warningId}.`);

    await logWarningRemoval(interaction, user.id, warningId);
    return interaction.reply({
      embeds: [makeEmbed('success', 'Warning removed', `Removed warning #${warningId} from <@${user.id}>.`)],
    });
  },
};

const warnings = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('List the active warnings of a member')
    .setDefaultMemberPermissions(MOD_PERMISSION)
    .addUserOption((option) => option.setName('user').setDescription('Member to check').setRequired(true)),

  async execute(interaction) {
    if (!hasPerm(interaction, MOD_PERMISSION)) return fail(interaction, NO_PERMISSION);

    const user = interaction.options.getUser('user', true);
    return interaction.reply({ ...buildWarningsView(interaction.guild.id, user.id), flags: MessageFlags.Ephemeral });
  },
};

module.exports = { warn, unwarn, warnings, handleUnwarnSelect };
