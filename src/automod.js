const { Events, PermissionFlagsBits } = require('discord.js');
const store = require('./storage');
const { makeEmbed, sendLog, truncate } = require('./utils');

// Defaults for a server that has not configured auto-moderation yet. Each strike is a warning;
// the timeout is applied when the member reaches a given strike.
const DEFAULT_TIMEOUT_AT = 3;
const DEFAULT_TIMEOUT_MINUTES = 10;
const MAX_WORDS = 100;
const WORD_MAX_LENGTH = 40;

function automodConfig(guildId) {
  const guild = store.guild(guildId);
  guild.automod ??= { enabled: false, words: [], timeoutAt: DEFAULT_TIMEOUT_AT, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES };
  return guild.automod;
}

// Words are matched on word boundaries, case-insensitively, so "class" does not trip on "ass".
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBlockedWord(config, content) {
  if (!config.enabled || !config.words.length || !content) return null;
  for (const word of config.words) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(word)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(content)) return word;
  }
  return null;
}

// Adds a warning to the same list /warn uses, so /warnings and /unwarn see it too.
function addStrike(guildId, userId, reason) {
  const settings = store.guild(guildId);
  const warning = { id: settings.nextWarningId++, reason, moderatorId: null, createdAt: Date.now(), auto: true };
  (settings.warnings[userId] ??= []).push(warning);
  store.save();
  return warning;
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const config = automodConfig(message.guild.id);
  const word = findBlockedWord(config, message.content);
  if (!word) return;

  // Staff are never auto-moderated, so an admin can always post what they need.
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  await message.delete().catch(() => {});

  const warning = addStrike(message.guild.id, message.author.id, `Blocked word in #${message.channel.name ?? message.channelId}`);
  const total = store.guild(message.guild.id).warnings[message.author.id].length;
  const shown = truncate(message.content || '(no text)', 500);
  const notice = makeEmbed(
    'warn',
    `⚠️ Warning ${total}/${config.timeoutAt}`,
    [
      `Your message in <#${message.channelId}> was removed because it contained a blocked word. Please be respectful on **${message.guild.name}**.`,
      '',
      `**Your message**\n> ${shown.split('\n').join('\n> ')}`,
      '',
      `At ${config.timeoutAt}/${config.timeoutAt} warnings you get a ${config.timeoutMinutes} minute timeout.`,
    ].join('\n'),
  );
  await message.channel.send({ content: `<@${message.author.id}>`, embeds: [notice] }).catch(() => {});

  if (total >= config.timeoutAt) {
    await message.member
      ?.timeout(config.timeoutMinutes * 60_000, `Auto-mod: warning ${total}/${config.timeoutAt}`)
      .catch(() => {});
  }

  await sendLog(message.guild, {
    embeds: [
      makeEmbed(
        'warn',
        'Auto-mod warning',
        `**Member:** <@${message.author.id}>\n**Warning:** #${warning.id} (${total} total)\n**Channel:** <#${message.channelId}>\n**Action:** message removed${total >= config.timeoutAt ? `, timed out ${config.timeoutMinutes} min` : ''}`,
      ),
    ],
  });
}

function register(client) {
  client.on(Events.MessageCreate, (message) => {
    return handleMessage(message).catch((err) => console.error('Auto-mod failed:', err.message));
  });
}

module.exports = {
  automodConfig,
  findBlockedWord,
  register,
  MAX_WORDS,
  WORD_MAX_LENGTH,
};
