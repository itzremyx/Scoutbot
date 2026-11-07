const { Events } = require('discord.js');
const store = require('./storage');
const { formatDuration } = require('./utils');

// Per-guild AFK statuses: guild.afk = { [userId]: { message, at } }.
// Told via /afk or the -afk prefix; cleared when the user sends any message again.
function afkMap(guildId) {
  const guild = store.guild(guildId);
  guild.afk ??= {};
  return guild.afk;
}

const getAfk = (guildId, userId) => afkMap(guildId)[String(userId)] ?? null;
const isAfk = (guildId, userId) => Boolean(getAfk(guildId, userId));

function setAfk(guildId, userId, message = 'I am away from my keyboard.') {
  afkMap(guildId)[String(userId)] = { message: String(message).slice(0, 300), at: Date.now() };
  store.save();
}

function clearAfk(guildId, userId) {
  const map = afkMap(guildId);
  if (map[String(userId)]) {
    delete map[String(userId)];
    store.save();
    return true;
  }
  return false;
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;

  // The -afk prefix is handled in chat.js; skip so the status is not cleared by the prefix message itself.
  if (message.content?.trim().toLowerCase().startsWith('-afk')) return;

  // Speaking again means the user is back: clear the status silently.
  if (isAfk(guildId, message.author.id)) clearAfk(guildId, message.author.id);

  // Mentioned AFK members.
  const mentioned = [...message.mentions.users.values()].filter((user) => isAfk(guildId, user.id));
  // Replied-to AFK member.
  if (!mentioned.length && message.reference?.messageId) {
    const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (ref && ref.author.id !== message.author.id && isAfk(guildId, ref.author.id)) mentioned.push(ref.author);
  }

  for (const user of mentioned) {
    const info = getAfk(guildId, user.id);
    const ago = formatDuration(Date.now() - info.at);
    await message.reply(`${user.username} is AFK — *${info.message}* (since ${ago})`).catch(() => {});
  }
}

function register(client) {
  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => console.error('AFK failed:', err.message));
  });
}

module.exports = { afkMap, getAfk, isAfk, setAfk, clearAfk, register };
