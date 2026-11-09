const { Events, PermissionFlagsBits } = require('discord.js');
const store = require('./storage');
const activity = require('./activity');
const { addModlogEntry } = require('./modlog');
const { makeEmbed, sendLog, truncate } = require('./utils');

// Anti-phishing: removes messages that link to known scam/phishing hosts, bare invite
// shorteners combined with scam bait, or classic "free Nitro / free Robux" lures. It is
// deliberately conservative: a plain link to an unknown site is left alone, only a match on
// the curated list (or scam wording plus a shortened link) triggers a removal.
const BAD_HOST_PATTERNS = [
  /(^|\.)discord-?nitro([.-]|$)/i,
  /(^|\.)discord-?gift([.-]|$)/i,
  /(^|\.)discord-?gifts?([.-]|$)/i,
  /(^|\.)nitro-?gift([.-]|$)/i,
  /(^|\.)nitro-?drop([.-]|$)/i,
  /(^|\.)gift-?discord([.-]|$)/i,
  /(^|\.)steam-?gift([.-]|$)/i,
  /(^|\.)steamgift([.-]|$)/i,
  /(^|\.)steamcommunity-?gift([.-]|$)/i,
  /(^|\.)csgo-?(skins|gift)([.-]|$)/i,
  /(^|\.)robux-?(generator|gift)([.-]|$)/i,
  /(^|\.)rbx-?(generator|gift)([.-]|$)/i,
  /(^|\.)vbucks-?(generator|gift)([.-]|$)/i,
  /(^|\.)free-?robux([.-]|$)/i,
  /(^|\.)free-?vbucks([.-]|$)/i,
  /(^|\.)claim-?nitro([.-]|$)/i,
  /(^|\.)nitro-?claim([.-]|$)/i,
  /(^|\.)airdrop-?nitro([.-]|$)/i,
  /(^|\.)drop-?nitro([.-]|$)/i,
];

const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'cutt.ly', 't.co', 'is.gd', 'v.gd', 'shorturl.at', 'shorturl.com',
  'rebrand.ly', 'ow.ly', 'rb.gy', 'tiny.cc', 'clck.ru', 't.ly', 'shorte.st', 's.id', 'cutt.us',
  'urlz.fr', 'goo.gl', 'x.gd', 'surl.li', 'short.gy', 'linktr.ee',
]);

const SCAM_BAIT = /(free\s+(nitro|robux|vbucks|v-?bucks|gift|skins?|steam)|nitro\s*(gift|drop|giveaway|for\s*free)|gift\s*(card|code)|steam\s*gift|robux|vbucks|airdrop|claim\s+(your|now)|discord\s*nitro)/i;

const LINK_RE = /(https?:\/\/[^\s<>()]+|(?:www\.)[^\s<>()]+|discord\.gg\/[A-Za-z0-9-]+)/gi;
const MAX_REASON = 300;

function phishConfig(guildId) {
  const guild = store.guild(guildId);
  guild.antiphish ??= { enabled: true, timeoutMinutes: 0 };
  if (guild.antiphish.enabled === undefined) guild.antiphish.enabled = true;
  if (guild.antiphish.timeoutMinutes === undefined) guild.antiphish.timeoutMinutes = 0;
  return guild.antiphish;
}

function extractLinks(text) {
  const links = [];
  for (const match of String(text || '').matchAll(LINK_RE)) {
    let raw = match[1];
    if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
    try {
      const url = new URL(raw);
      links.push({ href: match[1], host: url.hostname.toLowerCase().replace(/^www\./, '') });
    } catch {
      /* malformed URL, ignore */
    }
  }
  return links;
}

// Returns { reason, host } when the message should be removed, otherwise null.
function detect(text) {
  const content = String(text || '');
  const links = extractLinks(content);
  const bait = SCAM_BAIT.test(content);

  for (const link of links) {
    if (BAD_HOST_PATTERNS.some((pattern) => pattern.test(link.host))) {
      return { reason: `known phishing host (${link.host})`, host: link.host };
    }
    if (SHORTENERS.has(link.host) && bait) {
      return { reason: `shortened scam link (${link.host})`, host: link.host };
    }
    if (/\.(zip|mov|top|xyz|click|shop|gift)$/i.test(link.host) && bait) {
      return { reason: `suspicious scam link (${link.host})`, host: link.host };
    }
  }
  return null;
}

async function handleMessage(message) {
  if (!message.guild || message.author?.bot) return;
  const cfg = phishConfig(message.guild.id);
  if (!cfg.enabled) return;
  if (!message.content) return;

  // Staff are never auto-moderated, so an announcement can still share a link.
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const hit = detect(message.content);
  if (!hit) return;

  await message.delete().catch(() => {});
  addModlogEntry(message.guild.id, {
    userId: message.author.id,
    action: 'phishing',
    reason: truncate(`Removed a phishing link in #${message.channel.name ?? message.channelId}: ${hit.reason}`, MAX_REASON),
    meta: { channel: message.channelId, host: hit.host },
  });

  activity.record(message.guild.id, {
    kind: 'security',
    title: 'Phishing link removed',
    detail: `**Member:** <@${message.author.id}>\n**Channel:** <#${message.channelId}>\n**Reason:** ${hit.reason}`,
    userId: message.author.id,
    meta: { channelId: message.channelId, host: hit.host },
  });

  if (cfg.timeoutMinutes > 0 && message.member?.moderatable) {
    await message.member
      .timeout(cfg.timeoutMinutes * 60_000, `Anti-phishing: ${hit.reason}`)
      .catch(() => {});
  }

  await message.channel
    .send({
      content: `<@${message.author.id}>`,
      embeds: [
        makeEmbed(
          'error',
          'Phishing link removed',
          `Your message contained a link flagged as phishing (**${hit.host}**) and was removed. Sharing scam links can lead to a timeout.`,
        ),
      ],
      allowedMentions: { users: [message.author.id] },
    })
    .catch(() => {});

  await sendLog(message.guild, {
    embeds: [
      makeEmbed(
        'warn',
        'Phishing link removed',
        `**Member:** <@${message.author.id}>\n**Channel:** <#${message.channelId}>\n**Reason:** ${hit.reason}${cfg.timeoutMinutes > 0 ? `\n**Action:** timed out ${cfg.timeoutMinutes} min` : ''}`,
      ),
    ],
  });
}

function register(client) {
  client.on(Events.MessageCreate, (message) => {
    return handleMessage(message).catch((err) => console.error('Anti-phishing failed:', err.message));
  });
}

module.exports = { phishConfig, detect, extractLinks, handleMessage, register, SHORTENERS, BAD_HOST_PATTERNS };
