const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const autorole = require('../autorole');
const store = require('../storage');
const { makeEmbed } = require('../utils');

// /role all <role> — sets the auto-role given to every member who joins.
// The value is persisted in store.json so it survives restarts. Without a role it
// just shows the current auto-role.
module.exports = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Assign the auto-role given to new members (bot owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('all')
        .setDescription('Set (or show) the role given to every member who joins')
        .addRoleOption((o) => o.setName('role').setDescription('Role to assign on join'))),

  async execute(interaction) {
    const role = interaction.options.getRole('role');

    if (!role) {
      const current = autorole.roleId() || 'none';
      const display = current === 'none' ? 'none' : `<@&${current}>`;
      return interaction.reply({
        embeds: [makeEmbed('info', 'Auto-role', `Current auto-role: **${display}**\n\nRun \`/role all <role>\` to set it.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    store.data.settings.autoRoleId = String(role.id);
    store.save();
    return interaction.reply({
      embeds: [makeEmbed('success', 'Auto-role updated', `Members who join will now receive **${role.name}** (saved).`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
