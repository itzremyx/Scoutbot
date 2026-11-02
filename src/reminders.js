const store = require('./storage');
const { makeEmbed } = require('./utils');

const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 365 * 86_400_000;
const MAX_TEXT = 400;
const MAX_PER_USER = 10;
const MAX_TOTAL = 200;
const CHECK_EVERY_MS = 30_000;

// Reminders live in store.data.reminders, outside any guild: the same list serves DMs and servers.
function allReminders() {
  store.data.reminders ??= { nextId: 1, items: [] };
  return store.data.reminders;
}

function addReminder({ userId, channelId = null, guildId = null, delayMs, text }) {
  // Belt-and-braces: the command already validates through parseDuration.
  if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
    return { error: 'The reminder delay must be between 1 minute and 30 days.' };
  }
  const list = allReminders();
  const mine = list.items.filter((r) => r.userId === userId);
  if (mine.length >= MAX_PER_USER) {
    return { error: `You already have ${MAX_PER_USER} pending reminders. Cancel one with \`/remind cancel\` first.` };
  }
  if (list.items.length >= MAX_TOTAL) {
    return { error: 'The reminder list is full right now, please try again later.' };
  }

  const now = Date.now();
  const reminder = {
    id: list.nextId++,
    userId,
    // channelId null means "send it as a DM".
    channelId,
    guildId,
    text: String(text).slice(0, MAX_TEXT),
    createdAt: now,
    dueAt: now + delayMs,
  };
  list.items.push(reminder);
  store.save();
  return { reminder };
}

// Cancels one of the caller's own reminders. Returns it, or null if it does not exist.
function cancelReminder(userId, id) {
  const list = allReminders();
  const index = list.items.findIndex((r) => r.id === id && r.userId === userId);
  if (index === -1) return null;
  const [removed] = list.items.splice(index, 1);
  store.save();
  return removed;
}

const userReminders = (userId) =>
  allReminders().items.filter((r) => r.userId === userId).sort((a, b) => a.dueAt - b.dueAt);

// Sends one due reminder. It is removed from the store before any await, so the scheduler can
// never deliver it twice, even if the bot is restarted mid-send.
async function deliverReminder(client, reminder) {
  const list = allReminders();
  const index = list.items.indexOf(reminder);
  if (index === -1) return;
  list.items.splice(index, 1);
  store.save();

  const embed = makeEmbed('info', '⏰ Reminder', reminder.text);

  // The channel it was set in first; if it is gone or the bot cannot post there, fall back to a DM.
  if (reminder.channelId) {
    const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const sent = await channel
        .send({ content: `<@${reminder.userId}>`, embeds: [embed], allowedMentions: { users: [reminder.userId] } })
        .then(() => true)
        .catch(() => false);
      if (sent) return;
    }
  }

  const user = await client.users.fetch(reminder.userId).catch(() => null);
  await user?.send({ embeds: [embed] }).catch(() => {});
}

// Fires every overdue reminder, including ones whose time came while the bot was offline.
// Called from ClientReady, like the giveaway scheduler, so nothing is delivered too early.
function startScheduler(client) {
  const tick = async () => {
    const due = allReminders().items.filter((r) => r.dueAt <= Date.now());
    for (const reminder of due) {
      await deliverReminder(client, reminder).catch((err) => console.error('Reminder failed:', err.message));
    }
  };
  tick();
  setInterval(tick, CHECK_EVERY_MS);
}

module.exports = {
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  MAX_PER_USER,
  addReminder,
  cancelReminder,
  userReminders,
  deliverReminder,
  startScheduler,
};
