const fs = require('fs');
const path = require('path');
const config = require('./config');
const budget = require('./budget');
const store = require('./storage');

// Rolling in-memory samples of the bot's vital signs, used by the dashboard graphs.
// One sample per minute is kept for 7 days and persisted to data/metrics.json so a restart
// does not erase the history. The file is written atomically like the main store.
const FILE = path.join(__dirname, '..', 'data', 'metrics.json');
const SAMPLE_MS = 60_000;
const RETENTION_MS = 7 * 86_400_000;
const MAX_POINTS = 240;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed.samples) ? parsed.samples.filter((s) => s && Number.isFinite(s.t)) : [];
  } catch {
    return [];
  }
}

let samples = load();
let clientRef = null;
let dirty = false;
let timer = null;

function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ samples }));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[metrics] save failed:', err.message);
  }
}

function openTicketCount(guildId) {
  const tickets = store.data.guilds?.[guildId]?.tickets ?? {};
  return Object.keys(tickets).length;
}

function sampleNow(client = clientRef, at = Date.now()) {
  if (!client) return null;
  const ai = budget.status();
  const guild = client.guilds?.cache?.get(config.mainGuildId);
  const entry = {
    t: at,
    online: Boolean(client.isReady?.()),
    ping: Number.isFinite(client.ws?.ping) ? client.ws.ping : null,
    rss: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    tokens: ai.tokensToday,
    calls: ai.callsToday,
    images: ai.imageCallsToday,
    members: guild?.memberCount ?? 0,
    tickets: openTicketCount(config.mainGuildId),
  };

  samples.push(entry);
  const cutoff = at - RETENTION_MS;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  dirty = true;
  return entry;
}

// Averages a list of samples into at most MAX_POINTS buckets so a 7-day range stays light.
function bucketize(list, maxPoints = MAX_POINTS) {
  if (list.length <= maxPoints) return list;
  const size = Math.ceil(list.length / maxPoints);
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const avg = (key) => {
      const values = chunk.map((s) => s[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) : null;
    };
    const last = chunk[chunk.length - 1];
    out.push({ t: last.t, ping: avg('ping'), rss: avg('rss'), tokens: last.tokens, calls: last.calls, members: last.members, tickets: last.tickets });
  }
  return out;
}

const RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': RETENTION_MS };

function history(range = '24h') {
  const span = RANGES[range] ?? RANGES['24h'];
  const cutoff = Date.now() - span;
  return bucketize(samples.filter((s) => s.t >= cutoff));
}

function latest() {
  const last = samples[samples.length - 1] ?? null;
  const dayAgo = samples.filter((s) => s.t >= Date.now() - 86_400_000);
  const pingValues = dayAgo.map((s) => s.ping).filter((v) => typeof v === 'number');
  const avgPing = pingValues.length ? Math.round(pingValues.reduce((a, b) => a + b, 0) / pingValues.length) : null;
  return { last, sampleCount: samples.length, avgPing24h: avgPing };
}

function startScheduler(client) {
  clientRef = client;
  sampleNow(client);
  persist();
  if (timer) return;
  timer = setInterval(() => {
    sampleNow();
    persist();
  }, SAMPLE_MS);
  if (timer.unref) timer.unref();
  process.on('exit', persist);
  process.on('SIGTERM', () => {
    persist();
    process.exit(0);
  });
}

module.exports = { startScheduler, sampleNow, history, latest, persist, bucketize, RANGES };
