// Remembers the last message deleted in each text channel so /snipe can show it.
// Kept in memory: after a restart the snipe is empty until a new deletion happens.
const { Events } = require('discord.js');
const last = new Map(); // channelId -> { author, content, embeds, attachments, url, at }

function capture(channel, message) {
  if (!message?.id || !channel?.id) return;
  last.set(channel.id, {
    author: { id: message.author.id, username: message.author.username, tag: message.author.tag },
    content: message.content || '',
    embeds: message.embeds.map((embed) => ({ url: embed.url ?? embed.thumbnail?.url ?? null })),
    attachments: message.attachments.map((file) => ({ name: file.name, url: file.url })),
    url: message.url,
    at: Date.now(),
  });
}

function peek(channelId) {
  return last.get(channelId) ?? null;
}

function clear(channelId) {
  return last.delete(channelId);
}

// Partials let us snipe messages that were deleted and had not been fully fetched.
function register(client) {
  client.on(Events.MessageDelete, (message) => {
    try {
      capture(message.channel, message);
    } catch {
      // A partial that could not be resolved should not crash the listener.
    }
  });
}

module.exports = { capture, peek, clear, register };
