const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GatewayIntentBits } = require('discord.js');
const config = require('./config');
const budget = require('./budget');
const loader = require('./loader');
const store = require('./storage');
const health = require('./health');
const metrics = require('./metrics');
const stats = require('./stats');
const activity = require('./activity');
const backups = require('./backups');
const controls = require('./controls');
const security = require('./security');
const { labelOf } = require('./modlog');
const { formatDuration } = require('./utils');

// Owner-facing control panel for a single-server installation. It is disabled unless
// DASHBOARD_TOKEN is set; that value is the login password. A successful login sets an
// HMAC-signed, HttpOnly session cookie so the password never stays in the URL.
const STARTED_AT = Date.now();
const SESSION_COOKIE = 'scout_session';
const SESSION_TTL_MS = 7 * 86_400_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const MAX_BODY = 64 * 1024;

let clientRef = null;
let server = null;
const loginAttempts = new Map();
let probeCache = { at: 0, value: null };

// ---------------------------------------------------------------- helpers

const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resolveUserName(id) {
  const client = clientRef;
  const user = client?.users?.cache?.get(id) ?? client?.guilds?.cache?.get(config.mainGuildId)?.members?.cache?.get(id)?.user;
  return user?.username ?? null;
}

function extractMentions(text) {
  const ids = new Set();
  for (const match of String(text ?? '').matchAll(/<@!?(\d+)>/g)) ids.add(match[1]);
  return [...ids].map((id) => ({ id, name: resolveUserName(id) }));
}

function normalizeMessages(messages) {
  return messages.map((message) => ({
    at: message.at ?? null,
    author: message.author ?? 'unknown',
    text: message.text ?? '',
    pinned: Boolean(message.pinned),
    embeds: Number(message.embeds ?? 0) || 0,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    mentions: Array.isArray(message.mentions) && message.mentions.length ? message.mentions : extractMentions(message.text),
  }));
}

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

function ago(at) {
  if (!at) return '—';
  const diff = Date.now() - at;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

const dateLabel = (at) => (at ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function untilLabel(at) {
  if (!at) return '—';
  const diff = at - Date.now();
  if (diff <= 0) return 'expired';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pct(value, limit) {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((value / limit) * 100)));
}

function bar(value, limit) {
  const percent = pct(value, limit);
  if (percent === null) return '';
  const tone = percent >= 100 ? 'danger' : percent >= 80 ? 'warn' : '';
  return `<div class="bar ${tone}"><span style="width:${percent}%"></span></div>`;
}

function tokenCredential(req, url) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return header || req.headers['x-dashboard-token'] || url.searchParams.get('token') || '';
}

function tokenMatches(given) {
  const expected = Buffer.from(String(config.dashboard.token));
  const actual = Buffer.from(String(given || ''));
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function secretKey() {
  return crypto.createHash('sha256').update(`${config.dashboard.token}|scout-dashboard-v2`).digest();
}

function sign(value) {
  return crypto.createHmac('sha256', secretKey()).update(value).digest('base64url');
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (expected.length !== signature.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionCookie() {
  return `${SESSION_COOKIE}=${encodeURIComponent(createSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

function loginAllowed(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { first: now, count: 0 });
    return true;
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLogin(ip, ok) {
  const entry = loginAttempts.get(ip) ?? { first: Date.now(), count: 0 };
  entry.count = ok ? 0 : entry.count + 1;
  entry.first = ok ? Date.now() : entry.first;
  loginAttempts.set(ip, entry);
  if (loginAttempts.size > 1000) {
    for (const [key, value] of loginAttempts) if (Date.now() - value.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}

// ---------------------------------------------------------------- transcripts

function safeTranscriptName(name) {
  const raw = String(name || '');
  const base = path.basename(raw);
  if (base !== raw || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(base)) return null;
  return base;
}

function parseHeader(text, name) {
  const meta = { name, channelName: name.replace(/\.txt$/, ''), typeLabel: 'Ticket', userId: null, closedByName: 'unknown', createdAt: null, closedAt: null, messages: 0, pinned: 0 };
  for (const line of String(text).split(/\r?\n/).slice(0, 14)) {
    if (line.startsWith('----')) break;
    const value = line.slice(line.indexOf(':') + 1).trim();
    if (line.startsWith('Ticket:')) meta.channelName = value.replace(/^#/, '').replace(/\s*\([^)]*\)$/, '');
    else if (line.startsWith('Type:')) meta.typeLabel = value;
    else if (line.startsWith('Opened by:')) meta.userId = value;
    else if (line.startsWith('Opened at:')) meta.createdAt = Date.parse(value) || null;
    else if (line.startsWith('Closed by:')) meta.closedByName = value.replace(/\s*\([^)]*\)$/, '');
    else if (line.startsWith('Closed at:')) meta.closedAt = Date.parse(value) || null;
    else if (line.startsWith('Messages:')) meta.messages = Number(value) || 0;
    else if (line.startsWith('Pinned:')) meta.pinned = Number(value) || 0;
  }
  return meta;
}

function listTranscripts() {
  let names = [];
  try {
    names = fs.readdirSync(config.transcriptDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    const full = path.join(config.transcriptDir, name);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(config.transcriptDir, name.replace(/\.txt$/, '.json')), 'utf8'));
    } catch {
      try {
        meta = parseHeader(fs.readFileSync(full, 'utf8'), name);
      } catch {
        meta = { name };
      }
    }
    out.push({ ...meta, name, size: stat.size, mtime: stat.mtimeMs });
  }
  return out.sort((a, b) => (b.closedAt || b.mtime) - (a.closedAt || a.mtime));
}

function readTranscript(name) {
  const safe = safeTranscriptName(name);
  if (!safe) return null;
  const full = path.join(config.transcriptDir, safe);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const divider = lines.findIndex((line) => line.startsWith('----'));
  const header = parseHeader(text, safe);
  const messages = normalizeMessages(loadStructuredMessages(safe) ?? parseMessages(lines, divider));
  return { meta: { ...header, size: Buffer.byteLength(text) }, messages, text };
}

// Structured log written next to the .txt for recent tickets; older tickets fall back to parsing.
function loadStructuredMessages(safe) {
  try {
    const raw = fs.readFileSync(path.join(config.transcriptDir, safe.replace(/\.txt$/, '.messages.json')), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function parseMessages(lines, divider) {
  const messages = [];
  const pattern = /^\[([^\]]+)\] ([^:]+): (.*)$/;
  for (const line of lines.slice(divider + 1)) {
    const match = line.match(pattern);
    if (match) {
      const pinned = /\s📌$/.test(match[3]);
      let text = pinned ? match[3].replace(/\s📌$/, '') : match[3];
      let embeds = 0;
      let attachments = [];
      const embedMatch = text.match(/\s*\[embeds:\s*(\d+)\]/);
      if (embedMatch) {
        embeds = Number(embedMatch[1]);
        text = text.replace(embedMatch[0], '');
      }
      const attachMatch = text.match(/\s*\[attachments:\s*([\s\S]*?)\]/);
      if (attachMatch) {
        attachments = attachMatch[1]
          .split(/\s*,\s*(?=https?:\/\/)/)
          .map((url) => url.trim())
          .filter(Boolean)
          .map((url) => ({ url, name: null, contentType: null }));
        text = text.replace(attachMatch[0], '');
      }
      messages.push({ at: match[1], author: match[2], text: text.trim(), pinned, embeds, attachments, mentions: [] });
    } else if (messages.length && /^ {4}/.test(line)) {
      messages[messages.length - 1].text += '\n' + line.slice(4);
    }
  }
  return messages;
}

// ---------------------------------------------------------------- data

function guildRef() {
  return clientRef?.guilds?.cache?.get(config.mainGuildId) ?? null;
}

function baseData() {
  const client = clientRef;
  const guild = guildRef();
  const guildData = store.data.guilds?.[config.mainGuildId] ?? {};
  const ai = budget.status();
  const openTickets = Object.keys(guildData.tickets ?? {}).length;
  const openAppeals = Object.values(guildData.appeals?.items ?? {}).filter((item) => item.status === 'open').length;
  const warnings = Object.values(guildData.warnings ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0);
  const transcriptList = listTranscripts();
  return {
    uptime: Date.now() - STARTED_AT,
    uptimeLabel: formatDuration(Date.now() - STARTED_AT),
    ready: Boolean(client?.isReady?.()),
    ping: Number.isFinite(client?.ws?.ping) ? client.ws.ping : null,
    guild: guild
      ? {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL({ extension: 'png', size: 128 }),
          members: guild.memberCount,
          ownerId: guild.ownerId,
          createdAt: guild.createdTimestamp,
          boosts: guild.premiumSubscriptionCount ?? 0,
          roles: guild.roles.cache.size,
          channels: guild.channels.cache.size,
        }
      : null,
    guilds: guild ? [{ id: guild.id, name: guild.name, members: guild.memberCount, openTickets, openAppeals }] : [],
    openTickets,
    openAppeals,
    warnings,
    commands: loader.commandCount(),
    memoryMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    ai: {
      paused: ai.paused,
      model: store.data.settings?.aiModel || config.ai.model,
      tokensToday: ai.tokensToday,
      dailyLimit: Number.isFinite(ai.limit) ? ai.limit : null,
      callsToday: ai.callsToday,
      imagesToday: ai.imageCallsToday,
      imageLimit: Number.isFinite(ai.imageLimit) ? ai.imageLimit : null,
    },
    stats: stats.snapshot(),
    security: security.summary(),
    metrics: metrics.latest(),
    transcriptCount: transcriptList.length,
    transcriptBytes: transcriptList.reduce((sum, item) => sum + (item.size ?? 0), 0),
    backupCount: backups.listBackups(config.mainGuildId).length,
  };
}

// Kept for the old /api/status consumers.
function snapshot() {
  return baseData();
}

async function cachedProbe() {
  if (probeCache.value && Date.now() - probeCache.at < 60_000) return probeCache.value;
  const value = await health.probeAi().catch((err) => ({ ok: false, reason: err.message }));
  probeCache = { at: Date.now(), value };
  return value;
}

function serverDetail() {
  const guild = guildRef();
  if (!guild) return null;
  const g = store.guild(config.mainGuildId);
  const channels = guild.channels.cache;
  const tickets = Object.entries(g.tickets ?? {}).map(([channelId, ticket]) => ({
    channelId,
    channelName: channels.get(channelId)?.name ?? channelId,
    ...ticket,
  }));
  const appeals = Object.values(g.appeals?.items ?? {}).filter((item) => item.status === 'open');
  const warnings = Object.entries(g.warnings ?? {})
    .map(([userId, list]) => ({ userId, count: list?.length ?? 0 }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ extension: 'png', size: 256 }),
    banner: guild.bannerURL({ extension: 'png', size: 512 }),
    ownerId: guild.ownerId,
    createdAt: guild.createdTimestamp,
    memberCount: guild.memberCount,
    onlineCount: guild.members.cache.filter((member) => member.presence && member.presence.status !== 'offline').size,
    boosts: guild.premiumSubscriptionCount ?? 0,
    boostTier: guild.premiumTier,
    verification: guild.verificationLevel,
    roles: guild.roles.cache.size,
    channels: channels.size,
    textChannels: channels.filter((channel) => channel.type === 0 || channel.type === 5).size,
    voiceChannels: channels.filter((channel) => channel.type === 2 || channel.type === 13).size,
    emojis: guild.emojis.cache.size,
    tickets,
    appeals,
    warnings,
    feedbackCount: (g.feedback ?? []).length,
    transcriptCount: listTranscripts().length,
    config: {
      logChannelId: g.logChannelId ?? null,
      aiChannelId: config.aiChannelId ?? null,
      welcome: { enabled: g.welcome?.enabled ?? false, channelId: g.welcome?.channelId ?? null, dmEnabled: g.welcome?.dmEnabled !== false },
      automod: { enabled: g.automod?.enabled ?? false, words: g.automod?.words?.length ?? 0 },
      antiphish: { enabled: g.antiphish?.enabled !== false, timeoutMinutes: g.antiphish?.timeoutMinutes ?? 0 },
    },
  };
}

async function healthData() {
  const client = clientRef;
  const probe = await cachedProbe();
  const h = health.status();
  const intents = client?.options?.intents;
  let storeBytes = 0;
  try {
    storeBytes = fs.statSync(config.dataFile).size;
  } catch {
    storeBytes = 0;
  }
  const memory = process.memoryUsage();
  const latestBackup = backups.listBackups(config.mainGuildId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return {
    ready: Boolean(client?.isReady?.()),
    wsStatus: client?.ws?.status ?? 'offline',
    ping: Number.isFinite(client?.ws?.ping) ? client.ws.ping : null,
    uptime: process.uptime() * 1000,
    uptimeLabel: formatDuration(process.uptime() * 1000),
    dashboardUptime: Date.now() - STARTED_AT,
    memory: {
      rss: Number((memory.rss / 1024 / 1024).toFixed(1)),
      heapUsed: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    },
    intents: {
      guildMembers: intents?.has(GatewayIntentBits.GuildMembers) ?? null,
      messageContent: intents?.has(GatewayIntentBits.MessageContent) ?? null,
    },
    ai: { ...probe, baseUrl: config.ai.baseUrl, model: store.data.settings?.aiModel || config.ai.model },
    alerts: h.lastAlerts.slice(0, 10),
    storeBytes,
    transcriptCount: listTranscripts().length,
    metricsSamples: metrics.latest().sampleCount,
    avgPing24h: metrics.latest().avgPing24h,
    commit: (store.data.settings.botRepo?.lastSha ?? 'unknown').slice(0, 7),
    latestBackup,
  };
}

function activityFeed(limit = 80) {
  const guildId = config.mainGuildId;
  const g = store.guild(guildId);
  const recorded = activity.recent(guildId, limit);
  const modlog = (g.modlog?.entries ?? [])
    .slice(-limit)
    .map((entry) => ({
      id: `m${entry.id}`,
      kind: 'moderation',
      title: labelOf(entry),
      detail: `**Member:** <@${entry.userId}>${entry.reason ? ` — ${entry.reason}` : ''}`,
      userId: entry.userId,
      moderatorId: entry.moderatorId,
      at: entry.at,
      meta: entry.meta ?? null,
    }));
  return [...recorded, ...modlog].sort((a, b) => b.at - a.at).slice(0, limit);
}

// ---------------------------------------------------------------- render helpers

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  server: '<rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><circle cx="7" cy="7.25" r="1"/><circle cx="7" cy="16.75" r="1"/>',
  tickets: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z"/><path d="M12 5v14" stroke-dasharray="2 3"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  health: '<path d="M3 12h4l2-5 4 12 2-7h6"/>',
  security: '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  controls: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

function navItem(href, label, icon, active) {
  return `<a href="${href}" class="nav-item ${active ? 'active' : ''}">${svg(ICONS[icon])}<span>${label}</span></a>`;
}

const STYLES = `
:root{color-scheme:dark;--bg:#080a10;--bg-2:#0c0f17;--panel:#10141f;--panel-2:#141a28;--border:#202839;--text:#e9edf7;--muted:#8a93a8;--accent:#5b6cff;--accent-2:#8b5cf6;--ok:#2ecc71;--warn:#f5a623;--danger:#ff5566;--radius:14px}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.app{display:flex;min-height:100vh}
.sidebar{width:248px;flex:0 0 248px;position:fixed;inset:0 auto 0 0;background:linear-gradient(180deg,#0b0e16,#080a10);border-right:1px solid var(--border);padding:22px 16px;display:flex;flex-direction:column;gap:26px;z-index:20}
.brand{display:flex;align-items:center;gap:12px;padding:0 8px}
.logo{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 8px 22px rgba(91,108,255,.35);color:#fff}
.brand h1{font-size:16px;margin:0;letter-spacing:-.01em}
.brand p{margin:1px 0 0;font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}
.nav{display:flex;flex-direction:column;gap:4px}
.nav-label{font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#5c6579;padding:0 12px;margin:6px 0}
.nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:10px;color:var(--muted);font-size:13.5px;font-weight:500;transition:.15s}
.nav-item svg{width:18px;height:18px}
.nav-item:hover{background:rgba(255,255,255,.04);color:var(--text)}
.nav-item.active{background:rgba(91,108,255,.14);color:#c7cdff}
.nav-item.active svg{color:var(--accent)}
.sidebar-foot{margin-top:auto;display:flex;flex-direction:column;gap:4px}
.main{flex:1;margin-left:248px;min-width:0}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 30px;background:rgba(8,10,16,.82);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.topbar h2{margin:0;font-size:15px;font-weight:600}
.topbar .crumb{font-size:12px;color:var(--muted);margin-top:2px}
.status{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;background:var(--panel);border:1px solid var(--border);font-size:12px;font-weight:600}
.status .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.status.online .dot{background:var(--ok);box-shadow:0 0 0 0 rgba(46,204,113,.6);animation:pulse 2s infinite}
.status.offline .dot{background:var(--danger)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(46,204,113,.45)}70%{box-shadow:0 0 0 9px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}
.page{padding:28px 30px 60px;max-width:1240px}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.page-head h3{margin:0;font-size:22px;letter-spacing:-.02em}
.page-head p{margin:5px 0 0;color:var(--muted);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px}
.card{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:var(--radius);padding:18px;transition:.15s}
.card:hover{border-color:#2c3550;transform:translateY(-1px)}
.card .label{display:flex;align-items:center;gap:8px;font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600;margin-bottom:10px}
.card .value{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.card .value small{font-size:13px;font-weight:600;color:var(--muted)}
.card .hint{margin-top:7px;font-size:11.5px;color:var(--muted)}
.ok{color:var(--ok)}.bad{color:var(--danger)}.warn-t{color:var(--warn)}
.section{margin-top:26px}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.section-head h4{margin:0;font-size:14px;font-weight:600}
.section-head .more{font-size:12px;color:var(--accent)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.panel.flush{padding:0;overflow:hidden}
.grid-2{display:grid;grid-template-columns:1.5fr 1fr;gap:16px}
@media(max-width:980px){.grid-2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13.5px;vertical-align:middle}
thead th{color:var(--muted);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:rgba(255,255,255,.025)}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700}
.badge.info{background:rgba(91,108,255,.16);color:#aab3ff}
.badge.ok{background:rgba(46,204,113,.14);color:#67e0a0}
.badge.warn{background:rgba(245,166,35,.14);color:var(--warn)}
.badge.danger{background:rgba(255,85,102,.14);color:#ff8b96}
.badge.muted{background:rgba(255,255,255,.06);color:var(--muted)}
.bar{height:7px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}
.bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .4s}
.bar.warn span{background:linear-gradient(90deg,#e09a1c,var(--warn))}
.bar.danger span{background:linear-gradient(90deg,#e03e50,var(--danger))}
.ai-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:22px}
.ai-item .top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px}
.ai-item .name{font-size:12px;color:var(--muted);font-weight:600}
.ai-item .num{font-size:13.5px;font-weight:700}
.actions{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:20px;padding-top:18px;border-top:1px solid var(--border);flex-wrap:wrap}
.actions .state{font-size:12.5px;color:var(--muted)}
.btn{font:inherit;font-size:13px;font-weight:600;color:#fff;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 6px 16px rgba(91,108,255,.28);transition:.15s;display:inline-flex;align-items:center;gap:7px}
.btn:hover{filter:brightness(1.1)}
.btn:active{transform:translateY(1px)}
.btn.ghost{background:rgba(255,255,255,.05);box-shadow:none;border:1px solid var(--border);color:var(--text)}
.btn.ghost:hover{background:rgba(255,255,255,.09)}
.btn.ghost.active{background:rgba(91,108,255,.18);border-color:rgba(91,108,255,.45);color:#c7cdff}
.btn.danger{background:linear-gradient(135deg,#e04455,#ff5566);box-shadow:0 6px 16px rgba(255,85,102,.25)}
.btn.small{padding:6px 11px;font-size:11.5px;border-radius:8px}
.input{width:100%;font:inherit;font-size:13.5px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:11px 14px;outline:none;transition:.15s}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(91,108,255,.15)}
.search{display:flex;gap:10px;margin-bottom:18px}
.search .input{flex:1}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:7px;font-weight:600}
.chart{height:130px;position:relative}
.spark{width:100%;height:100%;display:block}
.empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:12px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:10px}
.legend b{color:var(--text);font-weight:700}
.feed{display:flex;flex-direction:column}
.feed-item{display:flex;gap:13px;padding:13px 0;border-bottom:1px solid var(--border)}
.feed-item:last-child{border-bottom:0}
.feed-icon{width:32px;height:32px;flex:0 0 32px;border-radius:9px;display:grid;place-items:center;background:rgba(91,108,255,.12);color:#aab3ff;font-size:14px}
.feed-icon.security{background:rgba(255,85,102,.12);color:#ff8b96}
.feed-icon.moderation{background:rgba(245,166,35,.12);color:var(--warn)}
.feed-icon.control{background:rgba(139,92,246,.14);color:#b79cff}
.feed-icon.ticket_closed{background:rgba(46,204,113,.12);color:#67e0a0}
.feed-body{min-width:0;flex:1}
.feed-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.feed-time{font-size:11px;color:var(--muted);font-weight:500}
.feed-detail{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5;word-break:break-word}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.kv-item{padding:12px 14px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px}
.kv-item .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
.kv-item .v{margin-top:5px;font-size:14px;font-weight:600;word-break:break-word}
.bubble-row{display:flex;margin:10px 0;gap:10px}
.bubble{max-width:76%;background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:10px 13px}
.bubble .author{font-size:12px;font-weight:700;color:#aab3ff;margin-bottom:4px;display:flex;gap:8px;align-items:center}
.bubble .meta{font-size:10.5px;color:var(--muted);font-weight:500}
.bubble .text{font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.bubble.pinned{border-color:rgba(245,166,35,.4);box-shadow:inset 0 0 0 1px rgba(245,166,35,.15)}
.mention{color:#aab3ff;background:rgba(91,108,255,.16);border-radius:5px;padding:0 4px;font-weight:600}
.attachments{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}
.att{display:block;border-radius:9px;overflow:hidden;border:1px solid var(--border);line-height:0}
.att img{display:block;max-width:280px;max-height:220px;width:auto;height:auto}
.att-file{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#aab3ff;border:1px solid var(--border);border-radius:8px;padding:6px 10px;text-decoration:none}
.att-file::before{content:'\\1F4CE'}
.embeds{margin-top:8px;font-size:11px;color:var(--muted)}
.transcript-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.transcript-head .avatar{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700}
.notice{position:fixed;right:22px;bottom:22px;z-index:60;max-width:360px;padding:13px 16px;border-radius:12px;background:var(--panel-2);border:1px solid var(--border);box-shadow:0 12px 30px rgba(0,0,0,.4);font-size:13px;opacity:0;transform:translateY(10px);transition:.2s;pointer-events:none}
.notice.show{opacity:1;transform:translateY(0)}
.notice.ok{border-color:rgba(46,204,113,.4)}
.notice.bad{border-color:rgba(255,85,102,.4)}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.spacer{height:19px}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.word-list{display:flex;flex-wrap:wrap;gap:8px}
.word-chip{display:inline-flex;align-items:center;gap:7px;background:rgba(255,85,102,.12);border:1px solid rgba(255,85,102,.3);color:#ffadb5;border-radius:999px;padding:4px 6px 4px 12px;font-size:12px;font-weight:600;margin:0}
.word-x{font:inherit;font-size:14px;font-weight:800;line-height:1;color:#ffadb5;background:rgba(255,255,255,.06);border:0;border-radius:999px;width:18px;height:18px;cursor:pointer;display:grid;place-items:center;padding:0}
.word-x:hover{background:rgba(255,255,255,.16)}
.filters{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px}
footer{padding:22px 30px 40px;color:#5c6579;font-size:11.5px;text-align:center}
@media(max-width:860px){
 .sidebar{position:static;width:100%;flex:none;flex-direction:row;align-items:center;overflow-x:auto;padding:12px;gap:14px}
 .brand p{display:none}
 .nav{flex-direction:row}
 .nav-label,.sidebar-foot{display:none}
 .main{margin-left:0}
 .topbar{padding:13px 16px}
 .page{padding:20px 16px 40px}
 .grid-2{grid-template-columns:1fr}
}
`;

const CLIENT_JS = `
function fmt(n){return Number(n||0).toLocaleString('en-US');}
function showNotice(message, ok){
  var el=document.getElementById('notice'); if(!el)return;
  el.textContent=message; el.className='notice show '+(ok?'ok':'bad');
  clearTimeout(window.__noticeTimer);
  window.__noticeTimer=setTimeout(function(){el.className='notice';},4200);
}
async function post(action){
  var res=await fetch('/api/control/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});
  var body={}; try{body=await res.json();}catch(e){}
  showNotice(body.message||(res.ok?'Done.':'Request failed ('+res.status+')'),res.ok&&body.ok!==false);
  if(action==='restart'&&res.ok)showNotice('Restart requested. The dashboard will reconnect shortly.',true);
}
function barHtml(value,limit){
  if(!limit||!isFinite(limit)||limit<=0)return '';
  var percent=Math.max(0,Math.min(100,Math.round((value/limit)*100)));
  var tone=percent>=100?'danger':percent>=80?'warn':'';
  return '<div class="bar '+tone+'"><span style="width:'+percent+'%"></span></div>';
}
function chart(el,points,key,color){
  if(!el)return;
  var w=el.clientWidth||600,h=el.clientHeight||130,pad=10;
  var vals=[]; for(var i=0;i<points.length;i++){var v=points[i][key]; if(typeof v==='number'&&isFinite(v))vals.push(v);}
  if(!vals.length){el.innerHTML='<div class="empty">No data yet — samples appear every minute.</div>';return;}
  var min=Math.min.apply(null,vals),max=Math.max.apply(null,vals);
  if(min===max){min-=1;max+=1;}
  var n=points.length;
  var coords=[];
  for(var j=0;j<n;j++){
    var value=points[j][key]; if(typeof value!=='number'||!isFinite(value))value=min;
    var x=pad+(n>1?j/(n-1):0)*(w-pad*2);
    var y=h-pad-((value-min)/(max-min))*(h-pad*2);
    coords.push([x,y]);
  }
  var line=coords.map(function(c,k){return (k?'L':'M')+c[0].toFixed(1)+' '+c[1].toFixed(1);}).join(' ');
  var area=line+' L'+(w-pad)+' '+(h-pad)+' L'+pad+' '+(h-pad)+' Z';
  var id='g'+Math.random().toString(36).slice(2);
  el.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" class="spark"><defs><linearGradient id="'+id+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity="0.34"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs><path d="'+area+'" fill="url(#'+id+')"/><path d="'+line+'" fill="none" stroke="'+color+'" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
}
function tokenDeltas(points){
  var out=[];
  for(var i=0;i<points.length;i++){
    var prev=i?points[i-1]:null;
    out.push({t:points[i].t,value:prev?Math.max(0,(points[i].tokens||0)-(prev.tokens||0)):0});
  }
  return out;
}
function drawOverview(range){
  var points=window.__HISTORY__||[];
  chart(document.getElementById('chart-ping'),points,'ping','#5b6cff');
  chart(document.getElementById('chart-rss'),points,'rss','#8b5cf6');
  chart(document.getElementById('chart-tokens'),tokenDeltas(points),'value','#2ecc71');
}
var __tick=0;
async function refreshOverview(){
  __tick++;
  try{
    var res=await fetch('/api/status',{cache:'no-store'});
    if(!res.ok)return;
    var data=await res.json();
    var set=function(id,value){var el=document.getElementById(id);if(el)el.textContent=value;};
    set('kpi-ping',(data.ping==null?'—':data.ping)+' ms');
    set('kpi-uptime',data.uptimeLabel);
    set('kpi-memory',data.memoryMb+' MB');
    set('kpi-members',fmt(data.guild?data.guild.members:0));
    set('kpi-tickets',fmt(data.openTickets));
    set('kpi-appeals',fmt(data.openAppeals));
    set('kpi-tokens',fmt(data.ai.tokensToday)+(data.ai.dailyLimit?' / '+fmt(data.ai.dailyLimit):''));
    set('kpi-images',fmt(data.ai.imagesToday)+(data.ai.imageLimit?' / '+fmt(data.ai.imageLimit):''));
    set('kpi-calls',fmt(data.ai.callsToday));
    set('kpi-commands',fmt(data.commands));
    var tb=document.getElementById('bar-tokens'); if(tb)tb.innerHTML=barHtml(data.ai.tokensToday,data.ai.dailyLimit);
    var ib=document.getElementById('bar-images'); if(ib)ib.innerHTML=barHtml(data.ai.imagesToday,data.ai.imageLimit);
    var st=document.getElementById('status'); if(st){st.classList.toggle('online',data.ready);st.classList.toggle('offline',!data.ready);var t=document.getElementById('status-text');if(t)t.textContent=data.ready?'Online':'Offline';}
    var aiState=document.getElementById('ai-state'); if(aiState)aiState.textContent=data.ai.paused?'paused':'active';
    var btn=document.getElementById('toggle'); if(btn){btn.dataset.paused=data.ai.paused?'true':'false';btn.textContent=data.ai.paused?'Resume AI':'Pause AI';}
  }catch(e){}
  if(__tick%15!==1)return;
  try{
    var range=window.__RANGE__||'24h';
    var r=await fetch('/api/history?range='+encodeURIComponent(range),{cache:'no-store'});
    if(r.ok){var hist=await r.json(); window.__HISTORY__=hist.points; drawOverview(range);}
  }catch(e){}
}
async function toggleAi(){
  var btn=document.getElementById('toggle'); if(!btn)return;
  var paused=btn.dataset.paused!=='true';
  var res=await fetch('/api/ai/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paused:paused})});
  if(res.ok){showNotice(paused?'AI paused.':'AI resumed.',true);refreshOverview();}
  else showNotice('Request failed ('+res.status+')',false);
}
async function submitJson(form){
  var data={};
  var fd=new FormData(form);
  fd.forEach(function(value,key){
    if(value===''||value==null)return;
    if(value==='true')data[key]=true;
    else if(value==='false')data[key]=false;
    else if(!isNaN(value)&&String(value).trim()!=='')data[key]=Number(value);
    else data[key]=value;
  });
  var endpoint=form.getAttribute('data-endpoint');
  var res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  var body={}; try{body=await res.json();}catch(e){}
  showNotice(body.message||(res.ok?'Saved.':'Request failed ('+res.status+')'),res.ok&&body.ok!==false);
  if(res.ok&&body.ok!==false)setTimeout(function(){location.reload();},700);
}
async function loadHistory(range){
  try{
    var res=await fetch('/api/history?range='+encodeURIComponent(range),{cache:'no-store'});
    if(!res.ok)return;
    var hist=await res.json();
    window.__HISTORY__=hist.points; window.__RANGE__=range;
    drawOverview();
    var btns=document.querySelectorAll('[data-range]');
    for(var i=0;i<btns.length;i++)btns[i].classList.toggle('active',btns[i].getAttribute('data-range')===range);
  }catch(e){}
}
document.addEventListener('DOMContentLoaded',function(){
  var toggle=document.getElementById('toggle'); if(toggle)toggle.addEventListener('click',toggleAi);
  var buttons=document.querySelectorAll('[data-control]');
  for(var i=0;i<buttons.length;i++){
    (function(btn){
      btn.addEventListener('click',function(){
        var action=btn.getAttribute('data-control');
        var confirmText=btn.getAttribute('data-confirm');
        if(confirmText&&!window.confirm(confirmText))return;
        btn.disabled=true;
        post(action).finally(function(){btn.disabled=false;});
      });
    })(buttons[i]);
  }
  var forms=document.querySelectorAll('form[data-endpoint]');
  for(var f=0;f<forms.length;f++){
    (function(form){form.addEventListener('submit',function(event){event.preventDefault();submitJson(form);});})(forms[f]);
  }
  var ranges=document.querySelectorAll('[data-range]');
  for(var r=0;r<ranges.length;r++){
    (function(btn){btn.addEventListener('click',function(){loadHistory(btn.getAttribute('data-range'));});})(ranges[r]);
  }
  if(document.getElementById('chart-ping')){drawOverview();setInterval(refreshOverview,1000);}
});
`;

function layout({ active, title, subtitle, content, ready, data }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ScoutBot</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">${svg('<circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 10 10"/><path d="M12 6a6 6 0 0 1 6 6"/><path d="M12 22A10 10 0 0 1 2 12"/><path d="M12 18a6 6 0 0 1-6-6"/>')}</div>
      <div><h1>ScoutBot</h1><p>Control panel</p></div>
    </div>
    <nav class="nav">
      <div class="nav-label">Monitoring</div>
      ${navItem('/', 'Overview', 'overview', active === 'overview')}
      ${navItem('/server', 'Server', 'server', active === 'server')}
      ${navItem('/activity', 'Activity', 'activity', active === 'activity')}
      ${navItem('/security', 'Security', 'security', active === 'security')}
      ${navItem('/health', 'Health', 'health', active === 'health')}
      <div class="nav-label">Support</div>
      ${navItem('/tickets', 'Tickets & transcripts', 'tickets', active === 'tickets')}
      <div class="nav-label">Administration</div>
      ${navItem('/controls', 'Controls', 'controls', active === 'controls')}
    </nav>
    <div class="sidebar-foot">
      ${navItem('/logout', 'Sign out', 'logout', false)}
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div>
        <h2>${esc(title)}</h2>
        <div class="crumb">${esc(subtitle || (data?.guild?.name ?? 'ScoutBot'))}</div>
      </div>
      <div class="status ${ready ? 'online' : 'offline'}" id="status"><span class="dot"></span><span id="status-text">${ready ? 'Online' : 'Offline'}</span></div>
    </header>
    <main class="page">${content}</main>
    <footer>ScoutBot dashboard · ${new Date().toISOString().slice(0, 10)} · <span class="mono">${esc((store.data.settings.botRepo?.lastSha ?? 'unknown').slice(0, 7))}</span></footer>
  </div>
</div>
<div class="notice" id="notice"></div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

function kpi(label, id, value, hint, tone = '') {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value ${tone}" id="${id}">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function feedHtml(items) {
  if (!items.length) return '<div class="empty" style="height:120px">No activity recorded yet.</div>';
  return `<div class="feed">${items
    .map(
      (item) => `<div class="feed-item">
        <div class="feed-icon ${esc(item.kind)}">${feedEmoji(item.kind)}</div>
        <div class="feed-body">
          <div class="feed-title">${esc(item.title)} <span class="feed-time">${ago(item.at)}</span>${item.meta?.transcript ? ` <a class="badge info" href="/transcripts/${encodeURIComponent(item.meta.transcript)}">transcript</a>` : ''}</div>
          <div class="feed-detail">${formatDetail(item.detail)}</div>
        </div>
      </div>`,
    )
    .join('')}</div>`;
}

const FEED_EMOJI = {
  ticket_opened: '🎫', ticket_closed: '🔒', appeal: '📨', security: '🛡️', control: '⚙️',
  moderation: '⚖️', feedback: '⭐', system: '•',
};
const feedEmoji = (kind) => FEED_EMOJI[kind] ?? '•';

// Activity details contain a few Discord mentions written as markdown; keep them readable.
function formatDetail(detail) {
  return esc(detail || '').replace(/&lt;@(\d+)&gt;/g, '@$1').replace(/&lt;#(\d+)&gt;/g, '#$1').replace(/\n/g, '<br>');
}

function renderOverview(data, historyPoints) {
  const content = `
    <div class="page-head">
      <div>
        <h3>Overview</h3>
        <p>Live health and usage for ${esc(data.guild?.name ?? 'your server')}.</p>
      </div>
      <a class="btn ghost small" href="/controls">Open controls</a>
    </div>
    <div class="cards">
      ${kpi('Ping', 'kpi-ping', `${data.ping ?? '—'} <small>ms</small>`)}
      ${kpi('Uptime', 'kpi-uptime', esc(data.uptimeLabel))}
      ${kpi('Memory', 'kpi-memory', `${data.memoryMb} <small>MB</small>`)}
      ${kpi('Members', 'kpi-members', fmt(data.guild?.members ?? 0))}
      ${kpi('Open tickets', 'kpi-tickets', fmt(data.openTickets))}
      ${kpi('Open appeals', 'kpi-appeals', fmt(data.openAppeals))}
      ${kpi('Commands', 'kpi-commands', fmt(data.commands))}
      ${kpi('AI model', 'kpi-model', esc(data.ai.model), `${fmt(data.ai.callsToday)} calls today`)}
      ${kpi('Raid mode', 'kpi-raid', data.security.raidActive ? '<span class="bad">ACTIVE</span>' : data.security.raidEnabled ? '<span class="warn-t">Armed</span>' : '<span class="ok">Off</span>', `${fmt(data.security.raidActions)} member(s) handled`)}
      ${kpi('Phishing (24h)', 'kpi-phish', fmt(data.security.phishingToday), `${fmt(data.security.blockedWords)} blocked word(s)`)}
    </div>

    <div class="section">
      <div class="section-head"><h4>Performance</h4><div style="display:flex;gap:7px">
        <button class="btn ghost small" data-range="1h">1h</button>
        <button class="btn ghost small active" data-range="24h">24h</button>
        <button class="btn ghost small" data-range="7d">7d</button>
      </div></div>
      <div class="grid-2">
        <div class="panel"><div class="ai-item"><div class="top"><span class="name">WebSocket ping</span><span class="num" id="kpi-ping2">${data.metrics.avgPing24h ?? '—'} ms avg</span></div><div class="chart" id="chart-ping"></div></div></div>
        <div class="panel"><div class="ai-item"><div class="top"><span class="name">Memory (RSS)</span><span class="num">${data.memoryMb} MB</span></div><div class="chart" id="chart-rss"></div></div></div>
      </div>
      <div class="panel" style="margin-top:16px"><div class="ai-item"><div class="top"><span class="name">AI tokens used per sample</span><span class="num">${fmt(data.ai.tokensToday)} today</span></div><div class="chart" id="chart-tokens"></div></div></div>
    </div>

    <div class="section">
      <div class="section-head"><h4>AI usage today</h4></div>
      <div class="panel">
        <div class="ai-row">
          <div class="ai-item"><div class="top"><span class="name">Tokens</span><span class="num" id="kpi-tokens">${fmt(data.ai.tokensToday)}${data.ai.dailyLimit ? ` / ${fmt(data.ai.dailyLimit)}` : ''}</span></div><div id="bar-tokens">${bar(data.ai.tokensToday, data.ai.dailyLimit)}</div></div>
          <div class="ai-item"><div class="top"><span class="name">Images</span><span class="num" id="kpi-images">${fmt(data.ai.imagesToday)}${data.ai.imageLimit ? ` / ${fmt(data.ai.imageLimit)}` : ''}</span></div><div id="bar-images">${bar(data.ai.imagesToday, data.ai.imageLimit)}</div></div>
          <div class="ai-item"><div class="top"><span class="name">API calls</span><span class="num" id="kpi-calls">${fmt(data.ai.callsToday)}</span></div><div class="bar"><span style="width:0%"></span></div></div>
        </div>
        <div class="actions">
          <div class="state">AI is currently <strong id="ai-state">${data.ai.paused ? 'paused' : 'active'}</strong></div>
          <button class="btn" id="toggle" data-paused="${data.ai.paused ? 'true' : 'false'}">${data.ai.paused ? 'Resume AI' : 'Pause AI'}</button>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h4>Recent activity</h4><a class="more" href="/activity">View all →</a></div>
      <div class="panel">${feedHtml(activityFeed(8))}</div>
    </div>
    <script>window.__HISTORY__=${safeJson(historyPoints)};window.__RANGE__='24h';</script>`;
  return layout({ active: 'overview', title: 'Overview', subtitle: data.guild?.name ?? 'ScoutBot', content, ready: data.ready, data });
}

function renderServer(detail, data) {
  if (!detail) {
    return layout({ active: 'server', title: 'Server', content: '<div class="panel"><div class="empty" style="height:160px">The server is not cached yet. Try again in a moment.</div></div>', ready: data.ready, data });
  }
  const cfg = detail.config;
  const channelList = [...(guildRef()?.channels?.cache?.values?.() ?? [])]
    .filter((channel) => channel.type === 0 || channel.type === 5 || channel.type === 2)
    .slice(0, 300)
    .map((channel) => `<option value="${esc(channel.id)}">${esc(channel.name ?? channel.id)}</option>`)
    .join('');
  const content = `
    <div class="page-head">
      <div class="transcript-head" style="margin-bottom:0">
        <div class="avatar" style="background:linear-gradient(135deg,#5b6cff,#8b5cf6)">${detail.icon ? `<img src="${esc(detail.icon)}" alt="" style="width:44px;height:44px;border-radius:12px;object-fit:cover">` : esc((detail.name || 'S').slice(0, 1))}</div>
        <div><h3 style="margin:0">${esc(detail.name)}</h3><p class="muted" style="margin:4px 0 0;font-size:12.5px">${detail.id} · created ${dateLabel(detail.createdAt)}</p></div>
      </div>
      <span class="badge ${detail.boosts > 0 ? 'info' : 'muted'}">${detail.boosts} boost${detail.boosts === 1 ? '' : 's'}</span>
    </div>

    <div class="cards">
      ${kpi('Members', 'srv-members', fmt(detail.memberCount))}
      ${kpi('Roles', 'srv-roles', fmt(detail.roles))}
      ${kpi('Channels', 'srv-channels', `${fmt(detail.channels)} <small>${detail.textChannels} text · ${detail.voiceChannels} voice</small>`)}
      ${kpi('Emojis', 'srv-emojis', fmt(detail.emojis))}
      ${kpi('Open tickets', 'srv-tickets', fmt(detail.tickets.length))}
      ${kpi('Open appeals', 'srv-appeals', fmt(detail.appeals.length))}
      ${kpi('Warnings', 'srv-warnings', fmt(detail.warnings.reduce((sum, item) => sum + item.count, 0)))}
      ${kpi('Transcripts', 'srv-transcripts', fmt(detail.transcriptCount))}
    </div>

    <div class="section">
      <div class="section-head"><h4>Configuration</h4></div>
      <div class="panel"><div class="kv">
        <div class="kv-item"><div class="k">Log channel</div><div class="v">${cfg.logChannelId ? `<span class="mono">${esc(cfg.logChannelId)}</span>` : '<span class="badge warn">not set</span>'}</div></div>
        <div class="kv-item"><div class="k">AI channel</div><div class="v">${cfg.aiChannelId ? `<span class="mono">${esc(cfg.aiChannelId)}</span>` : '<span class="badge warn">not set</span>'}</div></div>
        <div class="kv-item"><div class="k">Welcome</div><div class="v">${cfg.welcome.enabled ? '<span class="badge ok">on</span>' : '<span class="badge muted">off</span>'} ${cfg.welcome.channelId ? `<span class="mono">${esc(cfg.welcome.channelId)}</span>` : ''} ${cfg.welcome.dmEnabled ? '<span class="badge info">DM</span>' : ''}</div></div>
        <div class="kv-item"><div class="k">Auto-moderation</div><div class="v">${cfg.automod.enabled ? '<span class="badge ok">on</span>' : '<span class="badge muted">off</span>'} <span class="muted">${cfg.automod.words} blocked word(s)</span></div></div>
        <div class="kv-item"><div class="k">Anti-phishing</div><div class="v">${cfg.antiphish.enabled ? '<span class="badge ok">on</span>' : '<span class="badge muted">off</span>'} <span class="muted">${cfg.antiphish.timeoutMinutes > 0 ? `timeout ${cfg.antiphish.timeoutMinutes}m` : 'delete only'}</span></div></div>
        <div class="kv-item"><div class="k">Ticket feedback</div><div class="v">${fmt(detail.feedbackCount)} rating(s)</div></div>
      </div></div>
    </div>

    <div class="section">
      <div class="panel">
        <div class="section-head"><h4>Edit configuration</h4><span class="muted" style="font-size:12px">Changes apply immediately</span></div>
        <form data-endpoint="/api/server/config">
          <datalist id="channel-ids">${channelList}</datalist>
          <div class="form-grid">
            <div class="field"><label>Log channel ID</label><input class="input" name="logChannelId" list="channel-ids" value="${esc(cfg.logChannelId ?? '')}" placeholder="Channel ID"></div>
            <div class="field"><label>AI channel ID</label><input class="input" name="aiChannelId" list="channel-ids" value="${esc(cfg.aiChannelId ?? '')}" placeholder="Channel ID"></div>
            <div class="field"><label>Welcome channel ID</label><input class="input" name="welcomeChannelId" list="channel-ids" value="${esc(cfg.welcome.channelId ?? '')}" placeholder="Channel ID"></div>
            <div class="field"><label>Welcome messages</label><select class="input" name="welcomeEnabled"><option value="true"${cfg.welcome.enabled ? ' selected' : ''}>Enabled</option><option value="false"${cfg.welcome.enabled ? '' : ' selected'}>Disabled</option></select></div>
            <div class="field"><label>Welcome DM</label><select class="input" name="welcomeDm"><option value="true"${cfg.welcome.dmEnabled ? ' selected' : ''}>Enabled</option><option value="false"${cfg.welcome.dmEnabled ? '' : ' selected'}>Disabled</option></select></div>
          </div>
          <div class="actions"><div class="state">Leave a channel ID empty to unset it. Auto-moderation and anti-phishing are on the Security page.</div><button class="btn" type="submit">Save configuration</button></div>
        </form>
      </div>
    </div>

    <div class="section">
      <div class="grid-2">
        <div>
          <div class="section-head"><h4>Open tickets</h4></div>
          <div class="panel flush"><table><thead><tr><th>Channel</th><th>Type</th><th>Opened</th><th>Last activity</th></tr></thead><tbody>
          ${detail.tickets.length ? detail.tickets.map((ticket) => `<tr><td>#${esc(ticket.channelName)}</td><td><span class="badge info">${esc(ticket.type)}</span></td><td>${ago(ticket.createdAt)}</td><td>${ago(ticket.lastActivity || ticket.createdAt)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No open ticket.</td></tr>'}
          </tbody></table></div>
        </div>
        <div>
          <div class="section-head"><h4>Top warned members</h4></div>
          <div class="panel flush"><table><thead><tr><th>Member</th><th>Warnings</th></tr></thead><tbody>
          ${detail.warnings.length ? detail.warnings.map((item) => `<tr><td><span class="mono">${esc(item.userId)}</span></td><td><span class="badge warn">${item.count}</span></td></tr>`).join('') : '<tr><td colspan="2" class="muted">No warning recorded.</td></tr>'}
          </tbody></table></div>
        </div>
      </div>
    </div>

    ${detail.appeals.length ? `<div class="section"><div class="section-head"><h4>Open appeals</h4></div><div class="panel flush"><table><thead><tr><th>#</th><th>User</th><th>Submitted</th><th>Reason</th></tr></thead><tbody>
      ${detail.appeals.map((appeal) => `<tr><td>${appeal.id}</td><td><span class="mono">${esc(appeal.userId)}</span></td><td>${ago(appeal.createdAt)}</td><td>${esc(String(appeal.reason || '').slice(0, 180))}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}`;
  return layout({ active: 'server', title: 'Server', subtitle: detail.name, content, ready: data.ready, data });
}

function renderTickets(list, query = '') {
  const rows = list
    .map((item) => {
      const href = `/transcripts/${encodeURIComponent(item.name)}`;
      return `<tr>
        <td><a href="${href}"><strong>#${esc(item.channelName || item.name)}</strong></a><div class="muted mono" style="font-size:11px">${esc(item.name)}</div></td>
        <td><span class="badge info">${esc(item.typeLabel || item.type || 'Ticket')}</span></td>
        <td>${item.userId ? `<span class="mono">${esc(item.userId)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${item.closedByName ? esc(item.closedByName) : '<span class="muted">—</span>'}</td>
        <td>${fmt(item.messages ?? 0)}</td>
        <td>${ago(item.closedAt || item.mtime)}</td>
        <td><a class="btn ghost small" href="${href}">Open</a></td>
      </tr>`;
    })
    .join('');
  const content = `
    <div class="page-head"><div><h3>Tickets & transcripts</h3><p>${list.length} archived conversation(s), newest first.</p></div><a class="btn ghost small" href="/api/export/transcripts.csv">Export CSV</a></div>
    <form class="search" method="get" action="/tickets">
      <input class="input" type="search" name="q" value="${esc(query)}" placeholder="Search transcripts by keyword, member id or channel…">
      <button class="btn" type="submit">Search</button>
      ${query ? '<a class="btn ghost" href="/tickets">Clear</a>' : ''}
    </form>
    <div class="panel flush"><table>
      <thead><tr><th>Transcript</th><th>Type</th><th>Opened by</th><th>Closed by</th><th>Messages</th><th>Closed</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7"><div class="empty" style="height:120px">No transcript yet. They are saved automatically when a ticket closes.</div></td></tr>'}</tbody>
    </table></div>`;
  const data = baseData();
  return layout({ active: 'tickets', title: 'Tickets & transcripts', subtitle: query ? `Search: ${query}` : 'Archive', content, ready: data.ready, data });
}

function renderMessageText(message) {
  const text = String(message.text ?? '');
  if (!text) return '';
  const names = new Map((message.mentions ?? []).map((mention) => [String(mention.id), mention.name]));
  let out = '';
  let last = 0;
  const pattern = /<@!?(\d+)>|<@&(\d+)>|<#(\d+)>/g;
  let match;
  while ((match = pattern.exec(text))) {
    out += esc(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out += `<span class="mention">@${esc(names.get(match[1]) || match[1])}</span>`;
    } else if (match[2] !== undefined) {
      out += '<span class="mention">@role</span>';
    } else {
      out += `<span class="mention">#${esc(match[3])}</span>`;
    }
    last = match.index + match[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

function renderAttachments(message) {
  const files = message.attachments ?? [];
  if (!files.length) return '';
  const items = files
    .map((file) => {
      const url = String(file.url ?? '');
      if (!url) return '';
      const clean = url.split('?')[0];
      const name = esc(file.name || clean.split('/').pop() || 'file');
      const image = String(file.contentType ?? '').startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(clean);
      if (image) {
        return `<a class="att" href="${esc(clean)}" target="_blank" rel="noopener noreferrer"><img src="${esc(clean)}" alt="${name}" loading="lazy"></a>`;
      }
      return `<a class="att-file" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`;
    })
    .filter(Boolean)
    .join('');
  return items ? `<div class="attachments">${items}</div>` : '';
}

function renderTranscript(transcript, data) {
  const { meta, messages, text } = transcript;
  const body = messages
    .map((message) => {
      const body = renderMessageText(message);
      const embeds = message.embeds ? `<div class="embeds">${fmt(message.embeds)} embed${message.embeds === 1 ? '' : 's'}</div>` : '';
      const empty = !body && !message.attachments?.length && !message.embeds ? '<span class="muted">no text</span>' : '';
      return `<div class="bubble-row"><div class="bubble ${message.pinned ? 'pinned' : ''}">
        <div class="author">${esc(message.author)} <span class="meta">${esc(String(message.at ?? '').replace('T', ' ').slice(0, 16))}</span>${message.pinned ? ' <span class="badge warn" style="padding:1px 6px">pinned</span>' : ''}</div>
        ${body || empty ? `<div class="text">${body || empty}</div>` : ''}
        ${renderAttachments(message)}
        ${embeds}
      </div></div>`;
    })
    .join('');
  const content = `
    <div class="page-head">
      <div><a class="muted" href="/tickets" style="font-size:12.5px">← Back to transcripts</a><h3 style="margin:8px 0 0">#${esc(meta.channelName)}</h3><p>${esc(meta.typeLabel)} · ${fmt(meta.messages)} messages · ${fmt(meta.size)} bytes</p></div>
      <div style="display:flex;gap:9px">
        <a class="btn ghost" href="/transcripts/${encodeURIComponent(meta.name)}/download">Download .txt</a>
      </div>
    </div>
    <div class="panel"><div class="kv" style="margin-bottom:18px">
      <div class="kv-item"><div class="k">Opened by</div><div class="v">${esc((meta.userId && resolveUserName(String(meta.userId))) || meta.userId || 'unknown')}</div></div>
      <div class="kv-item"><div class="k">Opened</div><div class="v">${dateLabel(meta.createdAt)}</div></div>
      <div class="kv-item"><div class="k">Closed by</div><div class="v">${esc(meta.closedByName || 'unknown')}</div></div>
      <div class="kv-item"><div class="k">Closed</div><div class="v">${dateLabel(meta.closedAt)}</div></div>
    </div>
    ${body || `<pre class="mono" style="white-space:pre-wrap;line-height:1.5;color:var(--muted)">${esc(text.slice(0, 12000))}</pre>`}
    </div>`;
  return layout({ active: 'tickets', title: 'Transcript', subtitle: `#${meta.channelName}`, content, ready: data.ready, data });
}

function renderActivity(items, data, kind = null) {
  const filters = [
    ['', 'All'],
    ['security', 'Security'],
    ['moderation', 'Moderation'],
    ['ticket_opened', 'Tickets opened'],
    ['ticket_closed', 'Tickets closed'],
    ['appeal', 'Appeals'],
    ['control', 'Controls'],
    ['feedback', 'Feedback'],
  ];
  const tabs = filters
    .map(([value, label]) => `<a class="btn ghost small ${String(kind ?? '') === value ? 'active' : ''}" href="/activity${value ? `?kind=${value}` : ''}">${label}</a>`)
    .join('');
  const content = `
    <div class="page-head"><div><h3>Activity</h3><p>${kind ? `Filtered: ${esc(kind)}.` : 'Tickets, appeals, moderation, security and dashboard changes.'}</p></div><a class="btn ghost small" href="/api/export/activity.csv">Export CSV</a></div>
    <div class="filters">${tabs}</div>
    <div class="panel">${feedHtml(items)}</div>`;
  return layout({ active: 'activity', title: 'Activity', subtitle: kind ? `Activity · ${kind}` : 'Server journal', content, ready: data.ready, data });
}

function renderHealth(h, data) {
  const aiTone = h.ai.ok ? 'ok' : 'bad';
  const alertRows = h.alerts.length
    ? h.alerts.map((alert) => `<tr><td><span class="badge warn">${esc(alert.key)}</span></td><td>${ago(alert.at)}</td><td class="muted">${dateLabel(alert.at)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No alert in this process.</td></tr>';
  const content = `
    <div class="page-head"><div><h3>Health</h3><p>Gateway, intents, AI endpoint, storage and recent alerts.</p></div></div>
    <div class="cards">
      ${kpi('Gateway', 'h-ready', h.ready ? '<span class="ok">Ready</span>' : '<span class="bad">Offline</span>', `ws state: ${esc(h.wsStatus)}`)}
      ${kpi('Ping', 'h-ping', `${h.ping ?? '—'} <small>ms</small>`, `24h avg ${h.avgPing24h ?? '—'} ms`)}
      ${kpi('Uptime', 'h-uptime', esc(h.uptimeLabel), `dashboard ${formatDuration(h.dashboardUptime)}`)}
      ${kpi('Memory', 'h-memory', `${h.memory.rss} <small>MB</small>`, `heap ${h.memory.heapUsed} MB`)}
      ${kpi('AI endpoint', 'h-ai', h.ai.ok ? '<span class="ok">Reachable</span>' : '<span class="bad">Down</span>', esc(h.ai.reason || h.ai.baseUrl))}
      ${kpi('Store', 'h-store', `${(h.storeBytes / 1024).toFixed(0)} <small>KB</small>`, `${h.metricsSamples} metric samples`)}
    </div>
    <div class="section"><div class="grid-2">
      <div>
        <div class="section-head"><h4>Runtime</h4></div>
        <div class="panel"><div class="kv">
          <div class="kv-item"><div class="k">Commit</div><div class="v mono">${esc(h.commit)}</div></div>
          <div class="kv-item"><div class="k">Guild members intent</div><div class="v">${h.intents.guildMembers ? '<span class="badge ok">enabled</span>' : '<span class="badge danger">disabled</span>'}</div></div>
          <div class="kv-item"><div class="k">Message content intent</div><div class="v">${h.intents.messageContent ? '<span class="badge ok">enabled</span>' : '<span class="badge danger">disabled</span>'}</div></div>
          <div class="kv-item"><div class="k">Transcripts</div><div class="v">${fmt(h.transcriptCount)} archived</div></div>
          <div class="kv-item"><div class="k">Latest backup</div><div class="v">${h.latestBackup ? `#${h.latestBackup.id} · ${ago(h.latestBackup.createdAt)}` : '<span class="badge muted">none</span>'}</div></div>
          <div class="kv-item"><div class="k">AI model</div><div class="v mono">${esc(h.ai.model)}</div></div>
        </div></div>
      </div>
      <div>
        <div class="section-head"><h4>Recent alerts</h4></div>
        <div class="panel flush"><table><thead><tr><th>Type</th><th>When</th><th>Timestamp</th></tr></thead><tbody>${alertRows}</tbody></table></div>
      </div>
    </div></div>`;
  return layout({ active: 'health', title: 'Health', subtitle: 'Diagnostics', content, ready: data.ready, data });
}

function renderSecurity(sec, data) {
  const select = (name, value, options) =>
    `<select class="input" name="${name}">${options
      .map(([optionValue, label]) => `<option value="${esc(optionValue)}"${String(optionValue) === String(value) ? ' selected' : ''}>${esc(label)}</option>`)
      .join('')}</select>`;
  const number = (name, value, min, max) =>
    `<input class="input" type="number" name="${name}" value="${esc(value)}" min="${min}" max="${max}">`;
  const events = sec.events.map((event) => ({ kind: 'security', ...event }));
  const raidTone = sec.raid.active ? 'bad' : sec.raid.enabled ? 'warn-t' : 'ok';
  const words = sec.automod.words.length
    ? sec.automod.words
        .map(
          (word) => `<form data-endpoint="/api/security/words" class="word-chip">
            <span>${esc(word)}</span>
            <input type="hidden" name="action" value="remove">
            <input type="hidden" name="word" value="${esc(word)}">
            <button class="word-x" type="submit" title="Remove ${esc(word)}">×</button>
          </form>`,
        )
        .join('')
    : '<span class="muted">No blocked word yet.</span>';

  const content = `
    <div class="page-head">
      <div><h3>Security</h3><p>Raid protection, phishing, auto-moderation and intrusion monitoring.</p></div>
      <a class="btn ghost small" href="/api/export/activity.csv">Export activity CSV</a>
    </div>
    <div class="cards">
      ${kpi('Raid protection', 'sec-raid', sec.raid.active ? '<span class="bad">ACTIVE</span>' : sec.raid.enabled ? '<span class="warn-t">Armed</span>' : '<span class="ok">Off</span>', sec.raid.active ? `Ends ${untilLabel(sec.raid.endsAt)}` : sec.raid.enabled ? 'Window closed' : 'No raid window open')}
      ${kpi('Members handled', 'sec-actions', fmt(sec.raid.actions), 'Since raid mode was first used')}
      ${kpi('Phishing blocked (24h)', 'sec-phish', fmt(sec.stats.phishingToday), `${fmt(sec.stats.invitesToday)} invite link(s) removed`)}
      ${kpi('Blocked words', 'sec-words', fmt(sec.automod.count), `${sec.automod.enabled ? 'Auto-mod on' : 'Auto-mod off'} · max ${sec.automod.maxWords}`)}
      ${kpi('Anti-phishing', 'sec-antiphish', sec.antiphish.enabled ? '<span class="ok">On</span>' : '<span class="warn-t">Off</span>', sec.antiphish.timeoutMinutes ? `Timeout ${sec.antiphish.timeoutMinutes}m` : 'Delete only')}
      ${kpi('Alt detection', 'sec-alts', 'Log only', `Accounts under ${sec.alts.youngDays}d flagged`)}
      ${kpi('Anti-nuke', 'sec-nuke', `${sec.antinuke.threshold} actions`, `Within ${sec.antinuke.windowSeconds}s`)}
      ${kpi('Security events (24h)', 'sec-events', fmt(sec.stats.securityToday), 'Across all protections')}
    </div>

    <div class="section"><div class="grid-2">
      <div class="panel">
        <div class="section-head"><h4>Raid protection</h4><span class="badge ${sec.raid.active ? 'danger' : sec.raid.enabled ? 'warn' : 'muted'}">${sec.raid.active ? 'active' : sec.raid.enabled ? 'armed' : 'off'}</span></div>
        <p class="muted" style="font-size:12.5px;margin:0 0 16px">A join flood arms raid mode automatically. New members are timed out and very young accounts are kicked.</p>
        <form data-endpoint="/api/security/raid">
          <div class="form-grid">
            <div class="field"><label>Raid mode</label>${select('enabled', sec.raid.enabled ? 'true' : 'false', [['false', 'Off'], ['true', 'On (starts now)']])}</div>
            <div class="field"><label>Timeout per member (min)</label>${number('timeoutMinutes', sec.raid.timeoutMinutes, 1, 1440)}</div>
            <div class="field"><label>Auto trigger — joins</label>${number('joinThreshold', sec.raid.joinThreshold, 2, 100)}</div>
            <div class="field"><label>Auto trigger — window (s)</label>${number('joinWindowSeconds', sec.raid.joinWindowSeconds, 3, 600)}</div>
            <div class="field"><label>Kick accounts younger than (h)</label>${number('minAccountAgeHours', sec.raid.minAccountAgeHours, 0, 720)}</div>
            <div class="field"><label>Auto trigger</label>${select('autoEnabled', sec.raid.autoEnabled ? 'true' : 'false', [['true', 'Enabled'], ['false', 'Disabled']])}</div>
            <div class="field"><label>Young account action</label>${select('kickYoung', sec.raid.kickYoung ? 'true' : 'false', [['true', 'Kick'], ['false', 'Timeout only']])}</div>
          </div>
          <div class="actions"><div class="state">Last auto-trigger: ${sec.raid.lastTriggerAt ? ago(sec.raid.lastTriggerAt) : 'never'}</div><button class="btn" type="submit">Save raid settings</button></div>
        </form>
      </div>

      <div>
        <div class="panel">
          <div class="section-head"><h4>Anti-phishing</h4><span class="badge ${sec.antiphish.enabled ? 'ok' : 'muted'}">${sec.antiphish.enabled ? 'on' : 'off'}</span></div>
          <form data-endpoint="/api/security/antiphish">
            <div class="form-grid">
              <div class="field"><label>Filter</label>${select('enabled', sec.antiphish.enabled ? 'true' : 'false', [['true', 'Enabled'], ['false', 'Disabled']])}</div>
              <div class="field"><label>Timeout offender (min, 0 = none)</label>${number('timeoutMinutes', sec.antiphish.timeoutMinutes, 0, 1440)}</div>
            </div>
            <div class="actions"><div class="state">Deletes the message and records it in the moderation log.</div><button class="btn" type="submit">Save</button></div>
          </form>
        </div>
        <div class="panel" style="margin-top:16px">
          <div class="section-head"><h4>Altitude &amp; anti-nuke</h4></div>
          <div class="kv">
            <div class="kv-item"><div class="k">Alt detection</div><div class="v">Log only</div></div>
            <div class="kv-item"><div class="k">Flag younger than</div><div class="v">${sec.alts.youngDays} days</div></div>
            <div class="kv-item"><div class="k">Nuke threshold</div><div class="v">${sec.antinuke.threshold} actions / ${sec.antinuke.windowSeconds}s</div></div>
            <div class="kv-item"><div class="k">Nuke response</div><div class="v">Alert owner + raid mode</div></div>
          </div>
        </div>
      </div>
    </div></div>

    <div class="section">
      <div class="panel">
        <div class="section-head"><h4>Auto-moderation</h4><span class="badge ${sec.automod.enabled ? 'ok' : 'muted'}">${sec.automod.enabled ? 'on' : 'off'}</span></div>
        <form data-endpoint="/api/security/automod">
          <div class="form-grid">
            <div class="field"><label>Blocked-word filter</label>${select('enabled', sec.automod.enabled ? 'true' : 'false', [['true', 'Enabled'], ['false', 'Disabled']])}</div>
            <div class="field"><label>Timeout after strikes</label>${number('timeoutAt', sec.automod.timeoutAt, 1, 20)}</div>
            <div class="field"><label>Timeout length (min)</label>${number('timeoutMinutes', sec.automod.timeoutMinutes, 1, 1440)}</div>
          </div>
          <div class="actions"><div class="state">Invite links are always filtered for members without Manage Messages.</div><button class="btn" type="submit">Save</button></div>
        </form>
        <div class="spacer"></div>
        <div class="section-head" style="margin-bottom:10px"><h4>Blocked words</h4><span class="muted" style="font-size:12px">${sec.automod.count} / ${sec.automod.maxWords}</span></div>
        <div class="word-list">${words}</div>
        <form data-endpoint="/api/security/words" class="search" style="margin-top:14px">
          <input type="hidden" name="action" value="add">
          <input class="input" name="word" maxlength="${sec.automod.maxWordLength}" placeholder="Add a word or phrase to block…" autocomplete="off">
          <button class="btn" type="submit">Block word</button>
        </form>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h4>Recent security events</h4><a class="more" href="/activity?kind=security">Open activity →</a></div>
      <div class="panel">${feedHtml(events)}</div>
    </div>`;
  return layout({ active: 'security', title: 'Security', subtitle: 'Protection', content, ready: data.ready, data });
}


function renderControls(data) {
  const action = (id, label, description, confirmText, tone = '') =>
    `<div class="feed-item"><div class="feed-body"><div class="feed-title">${esc(label)}</div><div class="feed-detail">${esc(description)}</div></div><button class="btn ${tone}" data-control="${id}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}>Run</button></div>`;
  const content = `
    <div class="page-head"><div><h3>Controls</h3><p>Real actions executed in the running bot process.</p></div></div>
    <div class="grid-2">
      <div class="panel">
        <div class="section-head"><h4>Maintenance</h4></div>
        <div class="feed">
          ${action('reload-config', 'Reload configuration', 'Re-read .env and reload slash command files. Stateful modules keep running.')}
          ${action('sync-commands', 'Re-sync slash commands', 'Re-register every slash command to the main server immediately.')}
          ${action('create-backup', 'Create a backup', 'Save a snapshot of roles and channels right now.')}
          ${action('prune-transcripts', 'Prune old transcripts', `Delete archived transcripts older than ${controls.PRUNE_DAYS} days.`)}
        </div>
      </div>
      <div class="panel">
        <div class="section-head"><h4>AI & process</h4></div>
        <div class="feed">
          ${action('reset-ai-usage', 'Reset AI usage today', 'Set the token, call and image counters back to zero.')}
          ${action('restart', 'Restart the bot', 'Exit the process so the panel starts it again. The dashboard reconnects after the restart.', 'Restart the bot now? The dashboard will be unavailable for a few seconds.', 'danger')}
        </div>
        <div class="actions"><div class="state">AI is currently <strong id="ai-state">${data.ai.paused ? 'paused' : 'active'}</strong></div><button class="btn" id="toggle" data-paused="${data.ai.paused ? 'true' : 'false'}">${data.ai.paused ? 'Resume AI' : 'Pause AI'}</button></div>
      </div>
    </div>`;
  return layout({ active: 'controls', title: 'Controls', subtitle: 'Administration', content, ready: data.ready, data });
}

function renderLogin(error = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ScoutBot</title>
<style>${STYLES}
.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(900px 500px at 15% -10%,rgba(91,108,255,.22),transparent 60%),radial-gradient(800px 500px at 100% 0%,rgba(139,92,246,.16),transparent 55%),var(--bg)}
.login{width:100%;max-width:390px;background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:18px;padding:34px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.login .logo{width:52px;height:52px;border-radius:14px;margin-bottom:18px}
.login h1{margin:0 0 6px;font-size:21px;letter-spacing:-.02em}
.login p{margin:0 0 24px;color:var(--muted);font-size:13px;line-height:1.5}
.login .error{background:rgba(255,85,102,.1);border:1px solid rgba(255,85,102,.3);color:#ff9aa4;font-size:12.5px;padding:10px 12px;border-radius:9px;margin-bottom:16px}
.login button{width:100%;margin-top:6px;justify-content:center}
.login .foot{margin-top:20px;text-align:center;color:#5c6579;font-size:11px}
</style>
</head>
<body>
<div class="login-wrap">
  <form class="login" method="post" action="/login">
    <div class="logo">${svg('<circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 10 10"/><path d="M12 6a6 6 0 0 1 6 6"/><path d="M12 22A10 10 0 0 1 2 12"/><path d="M12 18a6 6 0 0 1-6-6"/>')}</div>
    <h1>ScoutBot control panel</h1>
    <p>Sign in with the dashboard password to view server health, tickets and controls.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <div class="field"><label for="password">Dashboard password</label><input class="input" id="password" name="password" type="password" autocomplete="current-password" required autofocus></div>
    <button class="btn" type="submit">Sign in</button>
    <div class="foot">Protected area · all sessions are signed and expire after 7 days.</div>
  </form>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------- exports

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvBody(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function sendCsv(res, filename, rows) {
  return send(res, 200, csvBody(rows), 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

function exportActivityRows() {
  return [['when', 'kind', 'title', 'detail', 'user'], ...activityFeed(5000).map((item) => [dateLabel(item.at), item.kind, item.title, String(item.detail || '').replace(/<@(\d+)>/g, '$1'), item.userId ?? ''])];
}

function exportModlogRows() {
  const entries = store.guild(config.mainGuildId).modlog?.entries ?? [];
  return [
    ['when', 'action', 'member', 'moderator', 'reason'],
    ...entries.map((entry) => [dateLabel(entry.at), entry.action, entry.userId ?? '', entry.moderatorId ?? '', entry.reason ?? '']),
  ];
}

function exportFeedbackRows() {
  const feedback = store.guild(config.mainGuildId).feedback ?? [];
  return [['when', 'member', 'ticket type', 'rating'], ...feedback.map((item) => [dateLabel(item.at), item.userId ?? '', item.type ?? '', item.rating ?? ''])];
}

function exportTranscriptRows() {
  return [
    ['file', 'channel', 'type', 'opened by', 'closed by', 'messages', 'closed at'],
    ...listTranscripts().map((item) => [item.name, item.channelName ?? '', item.typeLabel ?? '', item.userId ?? '', item.closedByName ?? '', item.messages ?? '', dateLabel(item.closedAt || item.mtime)]),
  ];
}

function renderPage(data = baseData()) {
  return renderOverview(data, metrics.history('24h'));
}

// ---------------------------------------------------------------- http

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const cookies = parseCookies(req);
  const sessionOk = verifySession(cookies[SESSION_COOKIE]);
  const pageRequest = !pathname.startsWith('/api/');
  const bearerOk = tokenMatches(tokenCredential(req, url));

  // The old ?token= links upgrade themselves into a session cookie and drop the token from the URL.
  if (!sessionOk && pageRequest && url.searchParams.get('token') && bearerOk) {
    const clean = new URL(url.toString());
    clean.searchParams.delete('token');
    return redirect(res, clean.pathname + clean.search, { 'Set-Cookie': sessionCookie() });
  }

  if (pathname === '/login') {
    if (req.method === 'GET') {
      if (sessionOk) return redirect(res, '/');
      return send(res, 200, renderLogin(url.searchParams.get('error') === '1' ? 'Wrong password. Try again.' : ''), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST') {
      const ip = clientIp(req);
      if (!loginAllowed(ip)) {
        return send(res, 429, renderLogin('Too many attempts. Wait a few minutes and try again.'), 'text/html; charset=utf-8');
      }
      const body = await readBody(req).catch(() => ({}));
      const ok = tokenMatches(body.password);
      recordLogin(ip, ok);
      if (!ok) return send(res, 401, renderLogin('Wrong password. Try again.'), 'text/html; charset=utf-8');
      activity.record(config.mainGuildId, {
        kind: 'control',
        title: 'Dashboard login',
        detail: `Signed in from ${ip}.`,
      });
      const next = typeof body.next === 'string' && body.next.startsWith('/') ? body.next : '/';
      return redirect(res, next, { 'Set-Cookie': sessionCookie() });
    }
  }

  if (pathname === '/logout') {
    return redirect(res, '/login', { 'Set-Cookie': clearCookie() });
  }

  if (!sessionOk && !bearerOk) {
    if (pageRequest) return redirect(res, '/login');
    return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), 'application/json; charset=utf-8');
  }

  // ---- APIs
  if (pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(baseData(), null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const range = url.searchParams.get('range') || '24h';
    return send(res, 200, JSON.stringify({ range, points: metrics.history(range) }, null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/activity' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 80));
    return send(res, 200, JSON.stringify(activityFeed(limit)), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/server' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(serverDetail()), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(await healthData(), null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(stats.snapshot(), null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/security' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(security.securityData(), null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/export/activity.csv' && req.method === 'GET') {
    return sendCsv(res, 'scoutbot-activity.csv', exportActivityRows());
  }
  if (pathname === '/api/export/modlog.csv' && req.method === 'GET') {
    return sendCsv(res, 'scoutbot-modlog.csv', exportModlogRows());
  }
  if (pathname === '/api/export/feedback.csv' && req.method === 'GET') {
    return sendCsv(res, 'scoutbot-feedback.csv', exportFeedbackRows());
  }
  if (pathname === '/api/export/transcripts.csv' && req.method === 'GET') {
    return sendCsv(res, 'scoutbot-transcripts.csv', exportTranscriptRows());
  }

  if (pathname === '/api/transcripts' && req.method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    let list = listTranscripts();
    if (query) {
      list = list.filter((item) => JSON.stringify(item).toLowerCase().includes(query) || (() => {
        try {
          return fs.readFileSync(path.join(config.transcriptDir, item.name), 'utf8').toLowerCase().includes(query);
        } catch {
          return false;
        }
      })());
    }
    return send(res, 200, JSON.stringify(list, null, 2), 'application/json; charset=utf-8');
  }

  if (pathname.startsWith('/api/transcript/') && req.method === 'GET') {
    const transcript = readTranscript(pathname.slice('/api/transcript/'.length));
    if (!transcript) return send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify({ meta: transcript.meta, messages: transcript.messages }, null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/ai/pause' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (typeof body.paused !== 'boolean') {
      return send(res, 400, JSON.stringify({ error: 'paused must be a boolean' }), 'application/json; charset=utf-8');
    }
    budget.setPaused(body.paused);
    return send(res, 200, JSON.stringify({ paused: body.paused }), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/server/config' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const guild = guildRef();
    const normalizeId = (value) => {
      const id = String(value ?? '').trim();
      if (!id) return null;
      if (!/^\d{17,20}$/.test(id)) return false;
      if (guild && !guild.channels.cache.has(id)) return false;
      return id;
    };

    const logChannelId = normalizeId(body.logChannelId);
    const aiChannelId = normalizeId(body.aiChannelId);
    const welcomeChannelId = normalizeId(body.welcomeChannelId);
    if (logChannelId === false || aiChannelId === false || welcomeChannelId === false) {
      return send(res, 400, JSON.stringify({ ok: false, message: 'Unknown channel ID. Pick a channel from this server.' }), 'application/json; charset=utf-8');
    }

    const settings = store.guild(config.mainGuildId);
    settings.logChannelId = logChannelId;
    if (aiChannelId) store.data.settings.aiChannelId = aiChannelId;
    else delete store.data.settings.aiChannelId;

    settings.welcome ??= {};
    settings.welcome.channelId = welcomeChannelId;
    settings.welcome.enabled = body.welcomeEnabled !== false && body.welcomeEnabled !== 'false';
    settings.welcome.dmEnabled = body.welcomeDm !== false && body.welcomeDm !== 'false';
    store.save();

    activity.record(config.mainGuildId, {
      kind: 'control',
      title: 'Server configuration updated',
      detail: 'Log channel, AI channel and welcome settings changed from the dashboard.',
    });
    return send(res, 200, JSON.stringify({ ok: true, message: 'Configuration saved.' }), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/security/raid' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = security.updateRaid(body, 'dashboard');
    return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/security/antiphish' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = security.updateAntiphish(body, 'dashboard');
    return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/security/automod' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = security.updateAutomod(body, 'dashboard');
    return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
  }

  if (pathname === '/api/security/words' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = security.editWord(body, 'dashboard');
    return send(res, result.ok ? 200 : 400, JSON.stringify(result), 'application/json; charset=utf-8');
  }

  if (pathname.startsWith('/api/control/') && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const action = pathname.slice('/api/control/'.length);
    if (action === 'restart' && body.confirm !== true) {
      return send(res, 400, JSON.stringify({ ok: false, message: 'Confirmation required.' }), 'application/json; charset=utf-8');
    }
    const result = await controls.run(action, clientRef);
    return send(res, result.ok === false ? 400 : 200, JSON.stringify(result), 'application/json; charset=utf-8');
  }

  // ---- transcript download
  const downloadMatch = pathname.match(/^\/transcripts\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const transcript = readTranscript(downloadMatch[1]);
    if (!transcript) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, transcript.text, 'text/plain; charset=utf-8', {
      'Content-Disposition': `attachment; filename="${transcript.meta.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    });
  }

  if (req.method !== 'GET') {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  // ---- pages
  const data = baseData();
  if (pathname === '/') {
    return send(res, 200, renderOverview(data, metrics.history('24h')), 'text/html; charset=utf-8');
  }
  if (pathname === '/server') {
    return send(res, 200, renderServer(serverDetail(), data), 'text/html; charset=utf-8');
  }
  if (pathname === '/activity') {
    const kind = (url.searchParams.get('kind') || '').trim() || null;
    const items = kind ? activityFeed(300).filter((item) => item.kind === kind) : activityFeed(120);
    return send(res, 200, renderActivity(items, data, kind), 'text/html; charset=utf-8');
  }
  if (pathname === '/security') {
    return send(res, 200, renderSecurity(security.securityData(), data), 'text/html; charset=utf-8');
  }
  if (pathname === '/health') {
    return send(res, 200, renderHealth(await healthData(), data), 'text/html; charset=utf-8');
  }
  if (pathname === '/controls') {
    return send(res, 200, renderControls(data), 'text/html; charset=utf-8');
  }
  if (pathname === '/tickets') {
    const query = (url.searchParams.get('q') || '').trim();
    let list = listTranscripts();
    if (query) {
      const needle = query.toLowerCase();
      list = list.filter((item) => {
        if (JSON.stringify(item).toLowerCase().includes(needle)) return true;
        try {
          return fs.readFileSync(path.join(config.transcriptDir, item.name), 'utf8').toLowerCase().includes(needle);
        } catch {
          return false;
        }
      });
    }
    return send(res, 200, renderTickets(list, query), 'text/html; charset=utf-8');
  }
  const transcriptMatch = pathname.match(/^\/transcripts\/([^/]+)$/);
  if (transcriptMatch) {
    const transcript = readTranscript(transcriptMatch[1]);
    if (!transcript) return send(res, 404, layout({ active: 'tickets', title: 'Not found', content: '<div class="panel"><div class="empty" style="height:160px">This transcript does not exist.</div></div>', ready: false, data }), 'text/html; charset=utf-8');
    return send(res, 200, renderTranscript(transcript, data), 'text/html; charset=utf-8');
  }

  return send(res, 404, layout({ active: '', title: 'Not found', content: '<div class="panel"><div class="empty" style="height:160px">Page not found.</div></div>', ready: data.ready, data }), 'text/html; charset=utf-8');
}

function start(client) {
  clientRef = client;
  if (!config.dashboard.token) return;
  if (server) return;

  server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error('[dashboard] request failed:', err);
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: err.message }), 'application/json; charset=utf-8');
    });
  });

  server.on('error', (err) => console.error('[dashboard] failed:', err.message));
  server.listen(config.dashboard.port, () => {
    console.log(`Dashboard listening on port ${config.dashboard.port} (login required)`);
  });
}

module.exports = {
  start,
  snapshot,
  renderPage,
  renderLogin,
  renderSecurity,
  renderServer,
  renderActivity,
  renderHealth,
  renderControls,
  renderTranscript,
  listTranscripts,
  readTranscript,
  baseData,
  healthData,
  serverDetail,
  activityFeed,
  csvBody,
};
