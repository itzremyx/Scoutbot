const { ChannelType, Events } = require('discord.js');
const store = require('./storage');
const { makeEmbed, truncate } = require('./utils');

// A sticky is a message that stays at the bottom of a channel: every time someone posts there,
// the bot deletes the previous sticky and re-sends it, so it never gets buried. Entries live on
// the guild record in store.json as { message, channelId, content, options, count, lastPosted }
// where options.interval is the number of user messages allowed between re-posts (default 1,
// i.e. after every message) and options.embed is null or a colour name.
// Stickies are deliberately not a /logs category: re-posting one must never flood the log channel,
// so only /sticky set and /sticky remove are logged (from src/commands/sticky.js).

const REPOST_EVERY_MS = 5_000; // never re-send faster than this
const MAX_CONTENT = 900; // stays well inside the 2000 character message limit

function stickyConfig(guildId) {
  const guild = store.guild(guildId);
  guild.stickies ??= {};
  return guild;
}

async function sendSticky(client, guildId, entry) {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;
  const channel = await guild.channels.fetch(entry.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.log(`Sticky: channel ${entry.channelId} is gone`);
    return null;
  }
  if (!channel.permissionsFor(client.user)?.SendMessages) {
    console.log(`Sticky: missing SendMessages in #${channel.name}`);
    return null;
  }

  const payload = entry.options?.embed
    ? { embeds: [makeEmbed(entry.options.embed, '📌 Sticky', entry.content)] }
    : { content: truncate(entry.content, MAX_CONTENT) };

  const sent = await channel.send(payload).catch((err) => {
    console.log(`Sticky: send failed in ${guildId}/${entry.channelId}: ${err.message}`);
    return null;
  });
  if (!sent) return null;

  entry.message = sent.id;
  entry.count = 0;
  entry.lastPosted = Date.now();
  store.save();
  return sent;
}

// Fires when someone posts in a channel with a sticky. Bot messages and the sticky itself never count.
async function onMessageCreate(message) {
  if (!message.guild || message.author.bot) return;
  const entry = (store.guild(message.guild.id).stickies ?? {})[message.channelId];
  if (!entry || entry.message === message.id) return;

  entry.count = (entry.count ?? 0) + 1;
  if (entry.count < (entry.options?.interval ?? 1)) return;
  if (Date.now() - (entry.lastPosted ?? 0) < REPOST_EVERY_MS) return;

  const previous = entry.message ? await message.channel.messages.fetch(entry.message).catch(() => null) : null;
  if (previous) {
    // A sticky pinned by a moderator was done on purpose: leave it where it is instead of
    // deleting it (deleting a pinned message would silently remove the pin).
    if (previous.pinned) return;
    await previous.delete().catch(() => null);
    entry.message = null;
  }
  // The old message is missing (deleted by someone else): the sticky simply comes back, since
  // only /sticky remove can stop it.
  await sendSticky(message.client, message.guild.id, entry);
}

// Called by /sticky set: replaces any sticky already running in that channel.
async function set(client, guildId, channelId, content, options = {}) {
  const config = stickyConfig(guildId);
  if (config.stickies[channelId]) await remove(client, guildId, channelId); // replaces, never stacks

  const entry = {
    message: null,
    channelId,
    content: content.slice(0, MAX_CONTENT),
    options: { interval: Math.max(1, Math.min(50, options.interval ?? 1)), embed: options.embed ?? null },
    count: 0,
    lastPosted: 0,
  };
  const sent = await sendSticky(client, guildId, entry);
  if (!sent) return false;

  config.stickies[channelId] = entry;
  store.save();
  return true;
}

// Called by /sticky remove: deletes the message (if it still exists) and forgets the entry.
async function remove(client, guildId, channelId) {
  const config = stickyConfig(guildId);
  const entry = config.stickies[channelId];
  if (!entry) return false;

  if (entry.message) {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    const channel = guild ? await guild.channels.fetch(entry.channelId).catch(() => null) : null;
    const previous = channel ? await channel.messages.fetch(entry.message).catch(() => null) : null;
    if (previous) await previous.delete().catch(() => {});
  }

  delete config.stickies[channelId];
  store.save();
  return true;
}

// Short human-readable list for /sticky list. Returns null when the server has no stickies.
function list(guildId) {
  const entries = Object.entries(stickyConfig(guildId).stickies ?? {});
  if (!entries.length) return null;
  return entries.map(([, e]) => `<#${e.channelId}> — ${truncate(e.content, 60)}`).join('\n');
}

// Same, but with the stored message id and interval, so /sticky debug can explain what is watched.
function details(guildId) {
  const entries = Object.entries(stickyConfig(guildId).stickies ?? {});
  if (!entries.length) return null;
  return entries
    .map(([, e]) => `<#${e.channelId}> — message \`${e.message ?? 'none'}\`, re-posts every ${e.options?.interval ?? 1} message(s)`)
    .join('\n');
}

function register(client) {
  client.on(Events.MessageCreate, (message) =>
    onMessageCreate(message).catch((err) => console.error('Sticky error:', err.message)),
  );
}

module.exports = { register, set, remove, list, details, onMessageCreate };