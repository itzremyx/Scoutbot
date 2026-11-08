const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./storage');
const { fail, makeEmbed, sendLog } = require('./utils');

const TICKET_TYPES = {
  bugs: { label: 'Bugs', emoji: '🐛', description: 'Report something that is broken' },
  help: { label: 'Help', emoji: '❓', description: 'Ask for help or a question' },
  partnership: { label: 'Partnership', emoji: '🤝', description: 'Propose a partnership' },
};

const CATEGORY_NAME = 'Tickets';
const STAFF_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
];
const TICKET_USER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

function buildPanel(guild) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:select')
    .setPlaceholder('Choose a ticket type')
    .addOptions(
      Object.entries(TICKET_TYPES).map(([value, type]) => ({
        label: type.label,
        description: type.description,
        value,
        emoji: { name: type.emoji },
      })),
    );

  return {
    embeds: [
      makeEmbed(
        'info',
        `🎫 ${guild.name} Support`,
        'Need help or want to report something? Pick a category below and a private ticket will be opened for you.',
      ),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

// Ticket "Tickets" category is created on first use and remembered.
async function getTicketCategory(guild) {
  const settings = store.guild(guild.id);
  if (settings.ticketCategoryId) {
    const existing = await guild.channels.fetch(settings.ticketCategoryId).catch(() => null);
    if (existing) return existing;
  }

  const category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
  settings.ticketCategoryId = category.id;
  store.save();
  return category;
}

const MAX_TICKETS_PER_CATEGORY = 3;

// Returns the user's still-open ticket channels, optionally limited to one category.
// Drops tickets whose channel was deleted by hand.
async function openTickets(guild, userId, type) {
  const settings = store.guild(guild.id);
  const open = [];
  let cleaned = false;
  for (const [channelId, ticket] of Object.entries(settings.tickets)) {
    if (ticket.userId !== userId) continue;
    if (type && ticket.type !== type) continue;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel) {
      open.push(channel);
      continue;
    }

    delete settings.tickets[channelId]; // channel was deleted by hand
    cleaned = true;
  }
  if (cleaned) store.save();
  return open;
}

async function createTicket(guild, user, type) {
  const open = await openTickets(guild, user.id, type);
  if (open.length >= MAX_TICKETS_PER_CATEGORY) {
    const links = open.map((channel) => `${TICKET_TYPES[type].emoji} ${channel}`).join('\n');
    return {
      blocked: true,
      reply: `You already have **${open.length}/${MAX_TICKETS_PER_CATEGORY}** open tickets in the **${TICKET_TYPES[type].label}** category.\n${links}`,
    };
  }

  const category = await getTicketCategory(guild);
  const slug =
    user.username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';

  const staffRoles = guild.roles.cache.filter(
    (role) => role.id !== guild.id && STAFF_PERMISSIONS.some((perm) => role.permissions.has(perm)),
  );

  const channel = await guild.channels.create({
    name: `${type}-${slug}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${TICKET_TYPES[type].label} ticket opened by ${user.username} (${user.id})`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: TICKET_USER_PERMISSIONS },
      {
        id: guild.client.user.id,
        allow: [...TICKET_USER_PERMISSIONS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
      },
      ...staffRoles.map((role) => ({ id: role.id, allow: TICKET_USER_PERMISSIONS })),
    ],
  });

  store.guild(guild.id).tickets[channel.id] = { userId: user.id, type, createdAt: Date.now() };
  store.save();

  const info = TICKET_TYPES[type];
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:claim')
      .setLabel('Claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${user.id}>`,
    embeds: [
      makeEmbed(
        'info',
        `${info.emoji} ${info.label} ticket`,
        `Thanks for opening a ticket, <@${user.id}>.\nDescribe your request in as much detail as you can. A staff member will be with you soon.`,
      ),
    ],
    components: [controls],
  });

  return channel;
}

// Fetches every message in the channel, oldest first (Discord returns at most 100 per request).
async function fetchAllMessages(channel) {
  const all = [];
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    all.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return all.reverse();
}

// Writes the full ticket history to data/transcripts/<channel>-<id>.txt and returns the file path and name.
async function saveTranscript(channel, ticket, closedBy) {
  const messages = await fetchAllMessages(channel);
  const pinned = await channel.messages.fetchPinned().catch(() => new Map());
  const pinnedIds = new Set(pinned.keys());
  const header = [
    `Ticket: #${channel.name} (${channel.id})`,
    `Type: ${TICKET_TYPES[ticket.type]?.label ?? ticket.type}`,
    `Opened by: ${ticket.userId}`,
    `Opened at: ${new Date(ticket.createdAt).toISOString()}`,
    ...(ticket.claimedBy ? [`Claimed by: ${ticket.claimedBy}`] : []),
    `Closed by: ${closedBy.username} (${closedBy.id})`,
    `Closed at: ${new Date().toISOString()}`,
    `Messages: ${messages.length}`,
    ...(pinned.size ? [`Pinned: ${pinned.size}`] : []),
    '-'.repeat(60),
  ];
  const lines = messages.map((message) => {
    const text = (message.content || '[no text]').replace(/\n/g, '\n    ');
    const embeds = message.embeds.length ? ` [embeds: ${message.embeds.length}]` : '';
    const files = [...message.attachments.values()].map((file) => file.url);
    const attachments = files.length ? ` [attachments: ${files.join(', ')}]` : '';
    const pin = pinnedIds.has(message.id) ? ' 📌' : '';
    return `[${message.createdAt.toISOString()}] ${message.author.username}: ${text}${pin}${embeds}${attachments}`;
  });

  const name = `${channel.name}-${channel.id}.txt`;
  fs.mkdirSync(config.transcriptDir, { recursive: true });
  const filePath = path.join(config.transcriptDir, name);
  fs.writeFileSync(filePath, [...header, ...lines].join('\n') + '\n', 'utf8');
  return { path: filePath, name };
}

async function closeTicket(interaction) {
  const { channel, guild, user } = interaction;
  const settings = store.guild(guild.id);
  const ticket = settings.tickets[channel.id];
  if (!ticket) return fail(interaction, 'This channel is not an open ticket.');

  const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
  if (user.id !== ticket.userId && !isStaff) {
    return fail(interaction, 'Only the ticket owner or staff can close this ticket.');
  }

  await interaction.reply({ embeds: [makeEmbed('warn', 'Closing ticket', 'This ticket will be deleted in 5 seconds.')] });

  const transcript = await saveTranscript(channel, ticket, user).catch((err) => {
    console.error('Transcript failed:', err);
    return null;
  });
  delete settings.tickets[channel.id];
  store.save();

  const transcriptFiles = () =>
    transcript ? [new AttachmentBuilder(transcript.path, { name: transcript.name })] : [];

  await sendLog(guild, {
    embeds: [
      makeEmbed(
        'info',
        'Ticket closed',
        `**Channel:** ${channel.name}\n**Type:** ${TICKET_TYPES[ticket.type]?.label ?? ticket.type}\n**Opened by:** <@${ticket.userId}>\n**Closed by:** <@${user.id}>`,
      ),
    ],
    files: transcriptFiles(),
  });

  const opener = await guild.client.users.fetch(ticket.userId).catch(() => null);
  if (opener) {
    await opener
      .send({
        content: `Your ${TICKET_TYPES[ticket.type]?.label ?? ''} ticket in **${guild.name}** was closed. Here is the transcript.`,
        files: transcriptFiles(),
      })
      .catch(() => {});
  }

  setTimeout(() => {
    channel.delete(`Ticket closed by ${user.username}`).catch(() => {});
  }, 5000);
}

// Staff press Claim to take a ticket. Pressing it again (by the same staff member) releases it.
async function claimTicket(interaction) {
  const { channel, guild, user } = interaction;
  const settings = store.guild(guild.id);
  const ticket = settings.tickets[channel.id];
  if (!ticket) return fail(interaction, 'This channel is not an open ticket.');

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return fail(interaction, 'Only staff can claim tickets.');
  }

  if (ticket.claimedBy === user.id) {
    delete ticket.claimedBy;
    delete ticket.claimedAt;
    store.save();
    return interaction.reply({ embeds: [makeEmbed('info', 'Claim released', `<@${user.id}> released this ticket.`)] });
  }

  if (ticket.claimedBy) {
    return fail(interaction, `This ticket is already claimed by <@${ticket.claimedBy}>.`);
  }

  ticket.claimedBy = user.id;
  ticket.claimedAt = Date.now();
  store.save();
  return interaction.reply({ embeds: [makeEmbed('success', 'Ticket claimed', `<@${user.id}> is handling this ticket.`)] });
}

module.exports = {
  TICKET_TYPES,
  MAX_TICKETS_PER_CATEGORY,
  buildPanel,
  openTickets,
  createTicket,
  closeTicket,
  claimTicket,
};
