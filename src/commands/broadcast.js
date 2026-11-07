const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { fail, hasPerm, makeEmbed, truncate, sendLog } = require('../utils');

// Send one message to several channels at once (announcements). Channels are listed by id.
const broadcast = {
  guildOnly: true,
  data: new SlashCommandBuilder()
    .setName('broadcast')
    .setDescription('Send a message to several channels at once (announcements)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('text')
        .setDescription('Message to send (markdown allowed, max 2000 characters)')
        .setRequired(true)
        .setMaxLength(2000),
    )
    .addStringOption((option) =>
      option
        .setName('channels')
        .setDescription('Channel ids separated by commas (max 20), e.g. 123456789012345678, 987654321098765432')
        .setRequired(true)
        .setMaxLength(400),
    ),

  async execute(interaction) {
    if (!hasPerm(interaction, PermissionFlagsBits.Administrator)) {
      return fail(interaction, 'You need the Administrator permission to do this.');
    }

    const text = interaction.options.getString('text', true);
    const ids = interaction.options.getString('channels', true).split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)).slice(0, 20);
    if (!ids.length) return fail(interaction, 'No valid channel ids found. Use the full id (right-click a channel: Copy ID), separated by commas.');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sent = [];
    const failed = [];
    for (const id of ids) {
      const channel = await interaction.guild.channels.fetch(id).catch(() => null);
      if (!channel?.isTextBased()) {
        failed.push(id);
        continue;
      }
      try {
        await channel.send(text);
        sent.push(channel.name ?? channel.id);
      } catch {
        failed.push(channel.name ?? id);
      }
    }

    if (sent.length) {
      await sendLog(interaction.guild, {
        embeds: [
          makeEmbed(
            'info',
            'Broadcast sent',
            `**To:** ${sent.map((name) => `#${name}`).join(', ')}\n**Message:** ${truncate(text, 500)}\n**Moderator:** <@${interaction.user.id}>`,
          ),
        ],
      });
    }
    const note = failed.length ? `\nSkipped (${failed.length}): ${failed.map((name) => `#${name}`).join(', ')}` : '';
    return interaction.editReply({
      embeds: [makeEmbed('success', 'Broadcast complete', `Sent to **${sent.length}** channel(s).${note}`)],
    });
  },
};

module.exports = broadcast;
