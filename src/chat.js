const { Events, PermissionFlagsBits } = require('discord.js');
const ai = require('./ai');
const memory = require('./memory');
const config = require('./config');
const { splitText, makeEmbed, fail } = require('./utils');
const snipe = require('../snipe');

// Phrases that usually mean the admin wants a standing rule kept, not a one-off question.
const INSTRUCTION_HINT = /\b(remember|from now on|going forward|always|never|don'?t ever|make sure|rule|please (?:do )?(?:not )?(?:use|call|say|reply|answer|speak))\b/i;

// Admins (Manage Server) teaching the bot a rule for the whole server. Saved as a server instruction.
async function captureInstruction(message, question) {
  if (!message.guild || !INSTRUCTION_HINT.test(question)) return false;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return false;

  const rule = await ai.extractInstruction(question);
  if (!rule) return false;

  const saved = memory.addInstruction(message.guild.id, rule);
  if (saved === 'full') {
    await message.reply(`I already have ${memory.MAX_INSTRUCTIONS} server rules. Remove one with /memory server-forget first.`).catch(() => {});
    return true;
  }
  if (saved) await message.reply(`Got it, I'll always remember this in this server: *${saved.text}*`).catch(() => {});
  return Boolean(saved);
}

// True when the message replies to a message the bot itself sent (no mention needed).
async function repliesToBot(message, client) {
  const refId = message.reference?.messageId;
  if (!refId || typeof message.channel?.messages?.fetch !== 'function') return false;
  const ref = await message.channel.messages.fetch(refId).catch(() => null);
  return ref?.author?.id === client.user.id;
}

// In a server the bot answers when mentioned, when in the dedicated AI channel,
// or when someone replies to one of its messages. In a DM every message is a question.
// Returns null when the message should be ignored, otherwise the question text.
async function questionOf(message, client) {
  const content = message.content ?? '';
  if (message.guild) {
    const channelId = message.channelId ?? message.channel?.id;
    const inAiChannel = channelId === config.aiChannelId;
    // No fetch needed in the AI channel: everything there is already a question.
    const replying = !inAiChannel && (await repliesToBot(message, client).catch(() => false));
    if (!inAiChannel && !message.mentions.has(client.user) && !replying) return null;
    return content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  }
  return content.trim();
}

// Discord exposes attachment URLs directly; only pass image attachments to the vision model.
function imageUrlsOf(message) {
  return [...(message.attachments?.values?.() ?? [])]
    .filter((attachment) => attachment.contentType?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:\?|$)/i.test(attachment.url ?? ''))
    .map((attachment) => attachment.url)
    .filter(Boolean)
    .slice(0, 4);
}

// Message handler for chat replies: mentions, replies and AI channel in servers, plain conversation in DMs.
function register(client) {
  client.on(Events.MessageCreate, async (message) => {


    // Determine if this is a DM, get the question text and any image URLs.
    const isDM = !message.guild;
    const question = await questionOf(message, client);
    const imageUrls = imageUrlsOf(message);
    // Prefix command handling (e.g. "-snipe")
    // Message version missing? Replace with combined lines.
    const raw = message.content?.trim() ?? '';
    if (raw.startsWith('-')) {
      const [cmd, ...args] = raw.slice(1).trim().split(/\s+/);
      if (cmd.toLowerCase() === 'snipe') {
        const sub = args[0] ? args[0].toLowerCase() : null;
        if (sub === 'clear') {
          if (!message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await message.reply('You need Manage Messages permission to clear the snipe.').catch(() => {});
            return;
          }
          if (!snipe.clear(message.channel.id)) {
            await message.reply('There is no sniped message in this channel yet.').catch(() => {});
            return;
          }
          await message.reply('The sniped message for this channel has been forgotten.').catch(() => {});
          return;
        }
        const captured = snipe.peek(message.channel.id);
        if (!captured) {
          await message.reply('No message has been deleted in this channel since I started watching.').catch(() => {});
          return;
        }
        const author = captured.author;
        const age = Math.max(0, Math.round((Date.now() - captured.at) / 1000));
        const body = [captured.content,
          ...captured.attachments.map((file) => `[attachment: ${file.name}](${file.url})`),
          ...captured.embeds.filter((embed) => embed.url).map((embed) => `[embed](${embed.url})`)
        ].filter(Boolean).join('\n');
        const embed = makeEmbed('info', 'Deleted message', body || '*The message had no text or attachments.*')
          .setAuthor({ name: `${author.username ?? 'Unknown'}${author.tag ? ` (${author.tag})` : ''}`, iconURL: null })
          .addFields({ name: 'Deleted', value: `${age}s ago`, inline: true }, { name: 'Channel', value: `${message.channel}`, inline: true });
        if (captured.url) embed.setFooter({ text: captured.url });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
        return;
      }
    }




    if (!question && !imageUrls.length) {
      const hint = 'Yes? Ask me something or attach an image.';
      await (isDM ? message.channel.send(hint) : message.reply(hint)).catch(() => {});
      return;
    }

    const prompt = question || 'Please analyze the attached image(s) and describe what you see.';

    if (await captureInstruction(message, question).catch(() => false)) return;

    // One status message shows each step, then becomes the answer. Edits run in order so a late
    // progress edit can never overwrite the final answer. The status message is only sent after a
    // short delay, so an answer that comes back immediately is posted as a plain reply instead of
    // leaving a stray "Starting…" message behind; the latest step text is used when it is sent.
    let shown = null;
    let finished = false;
    let lastStatus = null;
    let queue = Promise.resolve();
    const progress = (text) => {
      lastStatus = text;
      queue = queue.then(() => shown?.edit(text)).catch(() => {});
    };
    const shownReady = new Promise((resolve) => {
      setTimeout(() => {
        if (finished) return resolve();
        message.reply(lastStatus ?? '⏳ Starting…')
          .then((shownMsg) => { shown = shownMsg; resolve(); })
          .catch(() => resolve());
      }, 400);
    });
    await message.channel.sendTyping().catch(() => {});
    // The typing indicator only lasts a few seconds; refresh it while the AI thinks.
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    try {
      const answer = await ai.chat({
        channelId: message.channelId ?? message.channel.id,
        guildId: message.guild?.id,
        botName: client.user.username,
        userId: message.author.id,
        speaker: message.author.username,
        question: prompt,
        imageUrls,
        onProgress: progress,
      });
      await shownReady;
      await queue;
      finished = true;
      const [first, ...rest] = splitText(answer);
      if (shown) await shown.edit(first).catch(() => message.reply(first));
      else await message.reply(first);
      for (const part of rest) await message.channel.send(part);
    } catch (err) {
      clearInterval(typing);
      await shownReady;
      await queue;
      finished = true;
      const text = `⚠️ ${err.message}`;
      await (shown ? shown.edit(text) : message.reply(text)).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });
}

module.exports = { register, questionOf, imageUrlsOf };
