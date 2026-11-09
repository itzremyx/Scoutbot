const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const store = require('./storage');
const activity = require('./activity');
const { makeEmbed, dmUser, truncate } = require('./utils');
const { clearForUser, listPunishments } = require('./punishments');

const MAX_REASON = 1000;
const MAX_APPEALS_PER_USER = 3;

// Appeals live on the guild record in store.json so staff decisions survive restarts.
function appealsOf(guildId) {
  const guild = store.guild(guildId);
  guild.appeals ??= { nextId: 1, items: {} };
  return guild.appeals;
}

const findAppeal = (guildId, id) => appealsOf(guildId).items[id] ?? null;

function listAppeals(guildId, status = 'open') {
  return Object.values(appealsOf(guildId).items)
    .filter((item) => (status ? item.status === status : true))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Returns true when the user is banned or has an active temporary punishment in this guild.
async function hasSomethingToAppeal(guild, userId) {
  if (listPunishments(guild.id).some((item) => item.userId === String(userId))) return true;
  const ban = await guild.bans.fetch(userId).catch(() => null);
  return Boolean(ban);
}

function createAppeal(guildId, { userId, username, reason, source }) {
  const cfg = appealsOf(guildId);
  const items = Object.values(cfg.items);
  const open = items.find((item) => item.userId === String(userId) && item.status === 'open');
  if (open) return { existing: open };
  if (items.filter((item) => item.userId === String(userId)).length >= MAX_APPEALS_PER_USER) {
    return { limit: true };
  }

  const id = cfg.nextId;
  cfg.nextId += 1;
  cfg.items[id] = {
    id,
    userId: String(userId),
    username: username ?? null,
    reason: truncate(reason, MAX_REASON),
    source,
    status: 'open',
    createdAt: Date.now(),
    reviewedBy: null,
    reviewedAt: null,
  };
  store.save();
  activity.record(guildId, {
    kind: 'appeal',
    title: `Appeal #${id} submitted`,
    detail: `**User:** <@${userId}>\n**Source:** ${source === 'dm' ? 'Direct message' : 'Server command'}\n${truncate(reason, 400)}`,
    userId,
    meta: { appealId: id, source },
  });
  return { appeal: cfg.items[id] };
}

function appealControls(id) {
  const button = (customId, label, emoji, style) =>
    new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);
  return new ActionRowBuilder().addComponents(
    button(`appeal:accept:${id}`, 'Accept', '✅', ButtonStyle.Success),
    button(`appeal:deny:${id}`, 'Deny', '⛔', ButtonStyle.Danger),
  );
}

function appealEmbed(appeal, decided = false) {
  const lines = [
    `**User:** <@${appeal.userId}> (${appeal.userId})`,
    appeal.username ? `**Username:** ${appeal.username}` : null,
    `**Source:** ${appeal.source === 'dm' ? 'Direct message' : 'Server command'}`,
    `**Submitted:** <t:${Math.floor(appeal.createdAt / 1000)}:R>`,
    '',
    `**Reason:**\n${appeal.reason}`,
  ].filter(Boolean);

  if (decided) {
    const verdict = appeal.status === 'accepted' ? 'Accepted' : 'Denied';
    lines.push(`\n**Decision:** ${verdict}${appeal.reviewedBy ? ` by <@${appeal.reviewedBy}>` : ''}`);
  }
  return makeEmbed(appeal.status === 'open' ? 'info' : appeal.status === 'accepted' ? 'success' : 'error', `Appeal #${appeal.id}`, lines.join('\n'));
}

async function postAppeal(guild, appeal) {
  const { logChannelId } = store.guild(guild.id);
  const channel = logChannelId ? await guild.channels.fetch(logChannelId).catch(() => null) : null;
  if (!channel?.isTextBased()) return null;
  return channel
    .send({ embeds: [appealEmbed(appeal)], components: [appealControls(appeal.id)] })
    .catch(() => null);
}

// Shared by /appeal and the DM "appeal <reason>" shortcut. Returns a user-facing message.
async function submitAppeal(client, user, reason, { guildId = config.mainGuildId, source = 'command' } = {}) {
  if (!reason || reason.trim().length < 10) {
    return { error: 'Please explain your appeal in a few words (at least 10 characters).' };
  }

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return { error: 'The server is unavailable right now. Try again later.' };

  const allowed = await hasSomethingToAppeal(guild, user.id).catch(() => false);
  if (!allowed) return { error: 'You have no active ban or temporary punishment to appeal.' };

  const result = createAppeal(guild.id, {
    userId: user.id,
    username: user.tag ?? user.username,
    reason: reason.trim(),
    source,
  });
  if (result.limit) return { error: 'You have reached the appeal limit. Contact the staff directly.' };
  if (result.existing) return { message: `You already have an open appeal (#${result.existing.id}). Staff will review it soon.` };

  const posted = await postAppeal(guild, result.appeal);
  if (!posted) {
    delete appealsOf(guild.id).items[result.appeal.id];
    store.save();
    return { error: 'Appeals are unavailable right now (no staff log channel is configured). Contact the staff directly.' };
  }
  return {
    appeal: result.appeal,
    message: `Your appeal (#${result.appeal.id}) has been sent to the staff. You will receive a DM once it is reviewed.`,
  };
}

async function handleAppealButton(interaction) {
  const [, action, rawId] = interaction.customId.split(':');
  const id = Number(rawId);

  const isStaff =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers);
  if (!isStaff) {
    return interaction.reply({
      content: 'You need Manage Server or Ban Members permission to review appeals.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const appeal = findAppeal(interaction.guild.id, id);
  if (!appeal) {
    return interaction.reply({ content: `Appeal #${id} no longer exists.`, flags: MessageFlags.Ephemeral });
  }
  if (appeal.status !== 'open') {
    return interaction.reply({ content: `Appeal #${id} was already ${appeal.status}.`, flags: MessageFlags.Ephemeral });
  }

  appeal.status = action === 'accept' ? 'accepted' : 'denied';
  appeal.reviewedBy = interaction.user.id;
  appeal.reviewedAt = Date.now();
  store.save();

  activity.record(interaction.guild.id, {
    kind: 'appeal',
    title: `Appeal #${id} ${appeal.status}`,
    detail: `**User:** <@${appeal.userId}>\n**Reviewed by:** <@${interaction.user.id}>`,
    userId: appeal.userId,
    meta: { appealId: id, decision: appeal.status },
  });

  if (appeal.status === 'accepted') {
    await interaction.guild.bans.remove(appeal.userId, `Appeal #${id} accepted by ${interaction.user.tag}`).catch(() => {});
    clearForUser(interaction.guild.id, appeal.userId, 'tempban');
    clearForUser(interaction.guild.id, appeal.userId, 'tempmute');
    const member = await interaction.guild.members.fetch(appeal.userId).catch(() => null);
    if (member?.isCommunicationDisabled()) {
      await member.timeout(null, `Appeal #${id} accepted`).catch(() => {});
    }
  }

  const user = await interaction.client.users.fetch(appeal.userId).catch(() => null);
  if (user) {
    const text =
      appeal.status === 'accepted'
        ? `Your appeal in **${interaction.guild.name}** was accepted. Your punishment has been lifted.`
        : `Your appeal in **${interaction.guild.name}** was denied. The staff decision stands.`;
    await dmUser(user, makeEmbed(appeal.status === 'accepted' ? 'success' : 'error', `Appeal #${id}`, text));
  }

  return interaction.update({ embeds: [appealEmbed(appeal, true)], components: [] });
}

// Placeholder so index.js can register the module like the other systems. Appeals are driven
// by the slash command, the DM shortcut and the review buttons, so there is nothing to schedule.
function startScheduler() {}

module.exports = {
  MAX_REASON,
  appealsOf,
  findAppeal,
  listAppeals,
  createAppeal,
  submitAppeal,
  postAppeal,
  handleAppealButton,
  startScheduler,
};
