const { MessageFlags, ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { CATEGORIES, logConfig } = require('../logs');
const { fail, hasPerm, makeEmbed } = require('../utils');

const categoryChoices = Object.entries(CATEGORIES).map(([value, name]) => ({ name, value }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Configure the activity logs')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('status').setDescription('Show where logs go and what is logged'))
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Turn a log category on or off')
        .addStringOption((option) =>
          option.setName('category').setDescription('Category').setRequired(true).addChoices(...categoryChoices),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('ignore')
        .setDescription('Stop or resume logging messages from a channel')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    ),

  guildOnly: true,

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
      return fail(interaction, 'You need the Manage Server permission to use this command.');
    }

    const config = logConfig(interaction.guild.id);
    const sub = interaction.options.getSubcommand();

    if (sub === 'toggle') {
      const category = interaction.options.getString('category', true);
      const wasOff = config.logDisabled.includes(category);
      config.logDisabled = wasOff
        ? config.logDisabled.filter((c) => c !== category)
        : [...config.logDisabled, category];
      store.save();
      return interaction.reply({
        embeds: [
          makeEmbed('success', 'Log category updated', `${CATEGORIES[category]} logs are now **${wasOff ? 'on' : 'off'}**.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'ignore') {
      const channel = interaction.options.getChannel('channel', true);
      const wasIgnored = config.logIgnored.includes(channel.id);
      config.logIgnored = wasIgnored
        ? config.logIgnored.filter((id) => id !== channel.id)
        : [...config.logIgnored, channel.id];
      store.save();
      return interaction.reply({
        embeds: [
          makeEmbed(
            'success',
            'Ignored channels updated',
            `Messages in ${channel} are now **${wasIgnored ? 'logged' : 'ignored'}**.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = config.logChannelId ? `<#${config.logChannelId}>` : 'Not set (use /setup logs)';
    const categories = Object.entries(CATEGORIES)
      .map(([key, name]) => `${config.logDisabled.includes(key) ? '❌' : '✅'} ${name}`)
      .join('\n');
    const ignored = config.logIgnored.map((id) => `<#${id}>`).join(', ') || 'None';
    return interaction.reply({
      embeds: [
        makeEmbed(
          'info',
          'Activity logs',
          `**Channel:** ${channel}\n\n**Categories**\n${categories}\n\n**Ignored channels:** ${ignored}`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
