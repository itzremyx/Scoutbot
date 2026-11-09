const store = require('./storage');

// Lightweight command usage counters for the dashboard and the weekly report. They are kept in
// memory and flushed to the store once a minute, so a busy server does not rewrite data/store.json
// on every slash command.
const today = () => new Date().toISOString().slice(0, 10);

// Start of the current week (Monday 00:00 UTC), used by the weekly owner report.
function weekStart(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diff = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

let dirty = false;
let timer = null;

function state() {
  const stats = (store.data.settings.stats ??= {
    day: today(),
    today: {},
    total: {},
    commandsToday: 0,
    commandsTotal: 0,
  });
  stats.today ??= {};
  stats.total ??= {};
  stats.week ??= {};
  stats.commandsTotal ??= 0;
  if (stats.day !== today()) {
    stats.day = today();
    stats.today = {};
    stats.commandsToday = 0;
  }
  const week = weekStart();
  if (stats.weekStart !== week) {
    stats.weekStart = week;
    stats.week = {};
  }
  return stats;
}

function recordCommand(name) {
  if (!name) return;
  const stats = state();
  stats.today[name] = (stats.today[name] ?? 0) + 1;
  stats.week[name] = (stats.week[name] ?? 0) + 1;
  stats.total[name] = (stats.total[name] ?? 0) + 1;
  stats.commandsToday += 1;
  stats.commandsTotal += 1;
  dirty = true;
}

function flush() {
  if (!dirty) return;
  dirty = false;
  store.save();
}

const top = (record, limit = 10) =>
  Object.entries(record)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));

function snapshot() {
  const stats = state();
  return {
    day: stats.day,
    weekStart: stats.weekStart,
    commandsToday: stats.commandsToday,
    commandsTotal: stats.commandsTotal,
    today: top(stats.today),
    week: top(stats.week),
    total: top(stats.total),
  };
}

function startScheduler() {
  if (timer) return;
  timer = setInterval(flush, 60_000);
  if (timer.unref) timer.unref();
}

module.exports = { recordCommand, flush, snapshot, startScheduler, state, weekStart };
