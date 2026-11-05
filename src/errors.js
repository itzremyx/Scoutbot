const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const COLOR = 0xed4245;
const reported = new Map();

function clip(value, max = 900) {
  const text = String(value ?? 'Unknown error').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function reportError(client, source, err) {
  const message = clip(err?.stack || err?.message || err);
  const key = source + ':' + message.slice(0, 180);
  const now = Date.now();
  if (now - (reported.get(key) || 0) < 60_000) return;
  reported.set(key, now);

  const channelId = config.botRepoChannelId;
  const channel = channelId ? client.channels.cache.get(channelId) : null;
  if (!channel?.isTextBased?.()) {
    console.error('[error]', source, message);
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('ScoutBot error')
    .addFields(
      { name: 'Source', value: clip(source, 200), inline: true },
      { name: 'Time', value: `<t:${Math.floor(now / 1000)}:R>`, inline: true },
      { name: 'Details', value: '```\n' + clip(message, 1000) + '\n```' },
    )
    .setFooter({ text: 'ScoutBot error report' })
    .setTimestamp(now);
  channel.send({ embeds: [embed] }).catch((sendErr) => {
    console.error('[error] could not post error report:', sendErr.message);
  });
}

function install(client) {
  const fail = (source) => (err) => reportError(client, source, err);
  process.on('uncaughtException', (err) => {
    reportError(client, 'uncaughtException', err);
    console.error(err);
  });
  process.on('unhandledRejection', fail('unhandledRejection'));
  client.on('error', fail('client'));
  if (client.rest?.on) client.rest.on('error', fail('rest'));
  client.on('shardError', fail('shard'));
}

module.exports = { install, reportError, clip };
