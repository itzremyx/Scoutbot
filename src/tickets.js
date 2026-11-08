const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./storage');
const health = require('./health');
const { fail, makeEmbed, sendLog } = require('./utils');

const TICKET_TYPES = {
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
        'Need help or want to talk about a partnership? Pick a category below and a private ticket will be opened for you.',
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

// A ticket with no message for this long is closed automatically (with a transcript).
const INACTIVE_CLOSE_MS = 48 * 60 * 60 * 1000;
const TICKET_CHECK_EVERY_MS = 10 * 60 * 1000;
// Guards against two close paths (button + scheduler) racing on the same channel.
const closing = new Set();

const lastActivityOf = (ticket) => ticket.lastActivity ?? ticket.createdAt ?? 0;

// One rating button per star. The custom id carries everything the DM handler needs, because the
// ticket channel is already deleted when the member answers.
function feedbackRow(ticket, guildId) {
  return new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((rating) =>
      new ButtonBuilder()
        .setCustomId(`ticket:feedback:${guildId}:${ticket.type}:${ticket.userId}:${rating}`)
        .setLabel(`${rating} ★`)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
}

// Records activity in a ticket channel. Writes at most once a minute per ticket so a busy
// conversation does not rewrite the store on every message.
function touchTicket(guildId, channelId) {
  const ticket = store.data.guilds[guildId]?.tickets?.[channelId];
  if (!ticket) return;
  const now = Date.now();
  if (now - lastActivityOf(ticket) < 60_000) return;
  ticket.lastActivity = now;
  store.save();
}

// Counts any human message in a ticket channel as activity, so an active conversation is
// never closed by the 48-hour timer.
function register(client) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.guild || message.author?.bot) return;
    touchTicket(message.guild.id, message.channelId ?? message.channel?.id);
  });
}

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
  if (!TICKET_TYPES[type]) {
    return {
      blocked: true,
      reply: 'That ticket category is no longer available. Use the latest panel and pick **Help** or **Partnership**.',
    };
  }

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

  const now = Date.now();
  store.guild(guild.id).tickets[channel.id] = { userId: user.id, type, createdAt: now, lastActivity: now };
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

// Closes a ticket channel once, whichever path asked (button, command or the inactivity
// scheduler). The transcript is written first and then delivered to the activity-log channel
// and to the opener's DMs; if neither destination accepts it, the owner is alerted so the
// history is never silently lost.
async function closeTicketChannel(client, guild, channel, ticket, closedBy, reason = null) {
  if (closing.has(channel.id)) return false;
  closing.add(channel.id);
  try {
    const settings = store.guild(guild.id);
    const transcript = await saveTranscript(channel, ticket, closedBy).catch((err) => {
      console.error('Transcript failed:', err);
      return null;
    });
    delete settings.tickets[channel.id];
    store.save();

    const transcriptFiles = () =>
      transcript ? [new AttachmentBuilder(transcript.path, { name: transcript.name })] : [];
    const reasonLine = reason ? `\n**Reason:** ${reason}` : '';
    const closedByLine = closedBy?.id === client.user?.id
      ? 'ScoutBot (automatic)'
      : `<@${closedBy.id}>`;

    const logged = await sendLog(guild, {
      embeds: [
        makeEmbed(
          'info',
          'Ticket closed',
          `**Channel:** ${channel.name}\n**Type:** ${TICKET_TYPES[ticket.type]?.label ?? ticket.type}\n**Opened by:** <@${ticket.userId}>\n**Closed by:** ${closedByLine}${reasonLine}`,
        ),
      ],
      files: transcriptFiles(),
    });

    let delivered = false;
    const opener = await client.users.fetch(ticket.userId).catch(() => null);
    if (opener) {
      delivered = await opener
        .send({
          content: `Your ${TICKET_TYPES[ticket.type]?.label ?? ''} ticket in **${guild.name}** was closed${reason ? ` (${reason.replace(/\.$/, '')})` : ''}. Here is the transcript.`,
          files: transcriptFiles(),
        })
        .then(() => true)
        .catch(() => false);

      // A short feedback form follows the transcript, so the rating always reaches the log channel.
      await opener
        .send({
          content: `How was your **${TICKET_TYPES[ticket.type]?.label ?? ''}** ticket handled? Rate your experience from 1 to 5 stars.`,
          components: [feedbackRow(ticket, guild.id)],
        })
        .catch(() => {});
    }

    if (!logged && !delivered) {
      await health.alertOwner(
        'Ticket transcript could not be delivered',
        `Ticket **${channel.name}** in **${guild.name}** was closed, but neither the log channel nor the opener's DMs accepted the transcript. It is stored at \`${transcript?.path ?? 'unknown'}\`.`,
        { key: 'ticket-transcript' },
      ).catch(() => {});
    }

    await channel
      .send({ embeds: [makeEmbed('warn', 'Ticket closed', reason || `Closed by ${closedBy?.username ?? 'staff'}.`)] })
      .catch(() => {});
    setTimeout(() => {
      channel.delete(`Ticket closed by ${closedBy?.username ?? 'staff'}`).catch(() => {});
    }, 5000);
    return true;
  } finally {
    closing.delete(channel.id);
  }
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

  if (closing.has(channel.id)) return fail(interaction, 'This ticket is already closing.');

  await interaction.reply({ embeds: [makeEmbed('warn', 'Closing ticket', 'This ticket will be deleted in 5 seconds.')] });
  await closeTicketChannel(guild.client, guild, channel, ticket, user);
}

// Closes every ticket with no message for INACTIVE_CLOSE_MS, including tickets that were idle
// while the bot was offline. The channel, transcript and DM flow is identical to a manual close.
async function closeInactiveTickets(client) {
  for (const [guildId, data] of Object.entries(store.data.guilds)) {
    const tickets = data?.tickets ?? {};
    if (!Object.keys(tickets).length) continue;
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;

    for (const channelId of Object.keys(tickets)) {
      const ticket = store.data.guilds[guildId]?.tickets?.[channelId];
      if (!ticket) continue;
      if (Date.now() - lastActivityOf(ticket) < INACTIVE_CLOSE_MS) continue;

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        delete store.guild(guildId).tickets[channelId]; // deleted by hand
        store.save();
        continue;
      }
      const reason = `Automatically closed after ${Math.round(INACTIVE_CLOSE_MS / 3_600_000)} hours of inactivity.`;
      await closeTicketChannel(client, guild, channel, ticket, client.user, reason)
        .catch((err) => console.error('Auto-close failed for ' + channelId + ':', err.message));
    }
  }
}

function startScheduler(client) {
  const tick = () => closeInactiveTickets(client).catch((err) => console.error('Ticket scheduler failed:', err.message));
  setTimeout(tick, 60_000); // let the guild cache fill after login
  setInterval(tick, TICKET_CHECK_EVERY_MS);
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
  ticket.lastActivity = Date.now();
  store.save();
  return interaction.reply({ embeds: [makeEmbed('success', 'Ticket claimed', `<@${user.id}> is handling this ticket.`)] });
}

// Handles the 1-5 star buttons sent in the opener's DM after a ticket closes. The rating is stored
// on the guild record and posted to the activity log.
async function handleTicketFeedback(interaction) {
  const [, , guildId, type, openerId, ratingRaw] = interaction.customId.split(':');
  if (interaction.user.id !== openerId) {
    return interaction.reply({ content: 'This feedback form is not for you.', flags: MessageFlags.Ephemeral });
  }
  const rating = Number(ratingRaw);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return interaction.reply({ content: 'That rating is not valid.', flags: MessageFlags.Ephemeral });
  }

  const guild = interaction.client.guilds.cache.get(guildId)
    ?? await interaction.client.guilds.fetch(guildId).catch(() => null);

  // The rating is stored even if the guild is not cached, so feedback is never lost.
  const settings = store.guild(guildId);
  settings.feedback ??= [];
  settings.feedback.push({ userId: openerId, type, rating, at: Date.now() });
  if (settings.feedback.length > 500) settings.feedback.splice(0, settings.feedback.length - 500);
  store.save();

  if (guild) {
    const label = TICKET_TYPES[type]?.label ?? type;
    const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    await sendLog(guild, {
      embeds: [
        makeEmbed(
          'info',
          'Ticket feedback',
          `**Member:** <@${openerId}>\n**Category:** ${label}\n**Rating:** ${stars} (${rating}/5)`,
        ),
      ],
    });
  }

  return interaction.update({
    content: `Thank you for your feedback: ${'⭐'.repeat(rating)} (${rating}/5).`,
    embeds: [],
    components: [],
  });
}

module.exports = {
  TICKET_TYPES,
  MAX_TICKETS_PER_CATEGORY,
  INACTIVE_CLOSE_MS,
  buildPanel,
  openTickets,
  createTicket,
  closeTicket,
  closeTicketChannel,
  closeInactiveTickets,
  touchTicket,
  register,
  startScheduler,
  claimTicket,
  handleTicketFeedback,
};
