const { MessageFlags } = require('discord.js');
const { claimTicket, closeTicket, createTicket, findOpenTicket, TICKET_TYPES } = require('./tickets');
const { handleUnwarnSelect } = require('./commands/warn');
const { handleUnbanSelect } = require('./commands/moderation');
const { joinGiveaway } = require('./giveaways');
const { handleHelpSelect } = require('./help');
const { makeEmbed, sendLog } = require('./utils');

async function handleTicketSelect(interaction) {
  const type = interaction.values[0];
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = await findOpenTicket(interaction.guild, interaction.user.id);
  if (existing) {
    return interaction.editReply({ content: `You already have an open ticket: ${existing}` });
  }

  const channel = await createTicket(interaction.guild, interaction.user, type);
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

// Routes button and select menu interactions by customId.
async function handleComponent(interaction) {
  const id = interaction.customId;

  if (id === 'ticket:select') return handleTicketSelect(interaction);
  if (id === 'ticket:claim') return claimTicket(interaction);
  if (id === 'ticket:close') return closeTicket(interaction);
  if (id.startsWith('unwarn:select:')) return handleUnwarnSelect(interaction);
  if (id === 'unban:select') return handleUnbanSelect(interaction);
  if (id.startsWith('giveaway:join:')) return joinGiveaway(interaction);
  if (id === 'help:select') return handleHelpSelect(interaction, require('./loader').allCommands());
}

module.exports = { handleComponent };
