const config = require('./config');
const store = require('./storage');
const activity = require('./activity');
const backups = require('./backups');
const budget = require('./budget');
const stats = require('./stats');
const { modlogConfig, labelOf } = require('./modlog');
const { makeEmbed, formatDuration } = require('./utils');

// Weekly private report sent to the bot owner. It summarises the last seven days of server
// activity, moderation, support, AI usage and health. The timestamp of the last successful DM
// is stored so a restart cannot post twice.
const CHECK_MS = 60_000;
const REPORT_DAY = 1; // Monday (0 = Sunday)
const REPORT_HOUR = 9; // 09:00 UTC
const WEEK_MS = 7 * 86_400_000;

function reportConfig() {
  return (store.data.settings.weeklyReport ??= { lastSentAt: 0 });
}

function countModeration(guildId, since) {
  const actions = new Map();
  for (const entry of modlogConfig(guildId).entries) {
    if ((entry.at ?? 0) < since) continue;
    actions.set(entry.action, (actions.get(entry.action) ?? 0) + 1);
  }
  return actions;
}

function feedbackSummary(guildId, since) {
  const items = (store.guild(guildId).feedback ?? []).filter((item) => (item.at ?? 0) >= since);
  if (!items.length) return null;
  const total = items.reduce((sum, item) => sum + (item.rating ?? 0), 0);
  return { count: items.length, average: (total / items.length).toFixed(1) };
}

async function buildReport(client, { since = Date.now() - WEEK_MS } = {}) {
  const guildId = config.mainGuildId;
  const guild = client.guilds.cache.get(guildId);
  const guildData = store.guild(guildId);
  const ai = budget.status();
  const previous = reportConfig().previousAi ?? { tokens: 0, calls: 0, images: 0 };
  const delta = (current, before) => Math.max(0, (current ?? 0) - (before ?? 0));

  const fields = [];
  fields.push({
    name: '👥 Members',
    value: `${guild?.memberCount ?? 0} total\nJoined this week: ${guildData.joins ?? 0}\nLeft this week: ${guildData.leaves ?? 0}`,
    inline: true,
  });

  const ticketsOpened = activity.countSince(guildId, since, 'ticket_opened');
  const ticketsClosed = activity.countSince(guildId, since, 'ticket_closed');
  const feedback = feedbackSummary(guildId, since);
  fields.push({
    name: '🎫 Tickets',
    value: [
      `Opened: ${ticketsOpened}`,
      `Closed: ${ticketsClosed}`,
      feedback ? `Rating: ${feedback.average}/5 (${feedback.count})` : 'Rating: no feedback',
    ].join('\n'),
    inline: true,
  });

  const moderation = countModeration(guildId, since);
  const modLines = [...moderation.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([action, count]) => `${labelOf({ action })}: ${count}`);
  const appeals = activity.countSince(guildId, since, 'appeal');
  fields.push({
    name: '🛡️ Moderation',
    value: modLines.length ? `${modLines.join('\n')}\nAppeals: ${appeals}` : `No action this week\nAppeals: ${appeals}`,
    inline: true,
  });

  fields.push({
    name: '🤖 AI usage',
    value: [
      `Tokens: ${delta(ai.tokensToday, previous.tokens).toLocaleString('en-US')}`,
      `Calls: ${delta(ai.callsToday, previous.calls).toLocaleString('en-US')}`,
      `Images: ${delta(ai.imageCallsToday, previous.images).toLocaleString('en-US')}`,
    ].join('\n'),
    inline: true,
  });

  const topCommands = stats.snapshot().week.slice(0, 5);
  fields.push({
    name: '⌨️ Top commands',
    value: topCommands.length ? topCommands.map((c) => `/${c.name}: ${c.count}`).join('\n') : 'No command recorded',
    inline: true,
  });

  const security = activity.countSince(guildId, since, 'security');
  const controls = activity.countSince(guildId, since, 'control');
  fields.push({
    name: '🔒 Security',
    value: `Phishing links removed: ${security}\nDashboard changes: ${controls}`,
    inline: true,
  });

  const list = backups.listBackups(guildId);
  const latest = list.sort((a, b) => b.createdAt - a.createdAt)[0];
  fields.push({
    name: '💾 Backups',
    value: `${list.length} saved${latest ? `\nLast: <t:${Math.floor(latest.createdAt / 1000)}:R>` : ''}`,
    inline: true,
  });

  fields.push({
    name: '✅ Health',
    value: [
      `Uptime: ${formatDuration(process.uptime() * 1000)}`,
      `Ping: ${client.ws?.ping ?? '—'} ms`,
      `Memory: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`,
      `Commit: ${(store.data.settings.botRepo?.lastSha ?? 'unknown').slice(0, 7)}`,
    ].join('\n'),
    inline: true,
  });

  const embed = makeEmbed('info', '📊 Weekly owner report', `Server summary for the last 7 days.\n<t:${Math.floor(since / 1000)}:f> → <t:${Math.floor(Date.now() / 1000)}:f>`).addFields(fields);
  return { embed, since };
}

async function sendReport(client, { force = false } = {}) {
  const cfg = reportConfig();
  if (!force && Date.now() - (cfg.lastSentAt ?? 0) < WEEK_MS - 3_600_000) return false;

  const ai = budget.status();
  const { embed } = await buildReport(client);
  const owner = await client.users.fetch(config.owner.id).catch(() => null);
  if (!owner) return false;

  const sent = await owner.send({ embeds: [embed] }).then(() => true).catch(() => false);
  if (sent) {
    cfg.lastSentAt = Date.now();
    cfg.previousAi = { tokens: ai.tokensToday, calls: ai.callsToday, images: ai.imageCallsToday };
    store.save();
  }
  return sent;
}

async function runWeekly(client, now = Date.now()) {
  const date = new Date(now);
  if (date.getUTCDay() !== REPORT_DAY || date.getUTCHours() !== REPORT_HOUR || date.getUTCMinutes() !== 0) return false;
  return sendReport(client).catch((err) => {
    console.error('Weekly report failed:', err.message);
    return false;
  });
}

function startScheduler(client) {
  const tick = () => runWeekly(client).catch((err) => console.error('Weekly report scheduler failed:', err.message));
  tick();
  setInterval(tick, CHECK_MS);
}

module.exports = { buildReport, sendReport, runWeekly, startScheduler, reportConfig, WEEK_MS };
