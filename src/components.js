const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { claimTicket, closeTicket, createTicket, MAX_TICKETS_PER_CATEGORY, TICKET_TYPES } = require('./tickets');
const { handleUnwarnSelect } = require('./commands/warn');
const { handleUnbanSelect } = require('./commands/moderation');
const { joinGiveaway } = require('./giveaways');
const { handleHelpEnglish, handleHelpSelect } = require('./help');
const { makeEmbed, sendLog } = require('./utils');

async function handleTicketSelect(interaction) {
  const type = interaction.values[0];
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await createTicket(interaction.guild, interaction.user, type);
  if (result.blocked) {
    sendLog(interaction.guild, {
      embeds: [
        makeEmbed(
          'warn',
          'Ticket blocked',
          `**User:** <@${interaction.user.id}>\n**Category:** ${TICKET_TYPES[type]?.label ?? type}\n**Reason:** ${TICKET_TYPES[type] ? `limit of ${MAX_TICKETS_PER_CATEGORY} open tickets reached` : 'category removed'}.`,
        ),
      ],
    });
    return interaction.editReply({ content: result.reply });
  }

  const channel = result;
  await sendLog(interaction.guild, {
    embeds: [
      makeEmbed(
        'info',
        'Ticket opened',
        `**Channel:** ${channel}\n**Type:** ${TICKET_TYPES[type].label}\n**Opened by:** <@${interaction.user.id}>`,
      ),
    ],
  });
  return interaction.editReply({ content: `Your ticket is ready: ${channel}` });
}

// The unblock dropdown of /automod remove: only admins with Manage Server may use it.
async function handleAutomodRemoveSelect(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.update({
      content: 'You need the Manage Server permission to do that.',
      embeds: [],
      components: [],
    });
  }
  return require('./commands/automod').handleRemoveSelect(interaction);
}

// Routes button and select menu interactions by customId.
async function handleComponent(interaction) {
  const id = interaction.customId;

  if (id === 'ticket:select') return handleTicketSelect(interaction);
  if (id === 'ticket:claim') return claimTicket(interaction);
  if (id === 'ticket:close') return closeTicket(interaction);
  if (id.startsWith('unwarn:select:')) return handleUnwarnSelect(interaction);
  if (id === 'automod:remove') return handleAutomodRemoveSelect(interaction);
  if (id === 'unban:select') return handleUnbanSelect(interaction);
  if (id.startsWith('giveaway:join:')) return joinGiveaway(interaction);
  if (id.startsWith('help:select:')) return handleHelpSelect(interaction, require('./loader').allCommands());
  if (id === 'help:english') return handleHelpEnglish(interaction, require('./loader').allCommands());
}

module.exports = { handleComponent };
