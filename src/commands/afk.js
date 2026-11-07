const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { getAfk, setAfk, clearAfk } = require('../afk');
const { fail, makeEmbed, formatDuration } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Mark yourself as away from keyboard (or show your status)')
    .addStringOption((option) =>
      option.setName('message').setDescription('Your AFK message ("off" clears your status)').setMaxLength(300),
    ),

  guildOnly: true,

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const input = interaction.options.getString('message');

    if (input && /^(off|end)$/i.test(input.trim())) {
      if (!clearAfk(guildId, interaction.user.id)) return fail(interaction, 'You are not marked as AFK.');
      return interaction.reply({ embeds: [makeEmbed('success', 'AFK cleared', 'You are back online.')] });
    }

    const current = getAfk(guildId, interaction.user.id);
    if (!input) {
      if (!current) {
        return fail(interaction, 'You are not marked as AFK. Use `/afk message:Why you are away` (or `-afk ...` in chat) to set one.');
      }
      return interaction.reply({
        embeds: [makeEmbed('info', 'Your AFK status', `*${current.message}* — set ${formatDuration(Date.now() - current.at)} ago.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    setAfk(guildId, interaction.user.id, input.trim());
    return interaction.reply({
      embeds: [
        makeEmbed(
          'success',
          'AFK set',
          `You are now AFK: *${input.trim()}*.\nAnyone who mentions or replies to you will be told. Your status clears when you send a message.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
