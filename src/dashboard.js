const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const budget = require('./budget');
const loader = require('./loader');
const store = require('./storage');
const { formatDuration } = require('./utils');

// Minimal read-only status dashboard plus a pause/resume switch for the AI. It only starts
// when DASHBOARD_TOKEN is set, and every request must present that token, so a bare port on
// the host never exposes server data.
const startedAt = Date.now();
let clientRef = null;
let server = null;

function tokenOf(req, url) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return header || req.headers['x-dashboard-token'] || url.searchParams.get('token') || '';
}

function authorized(req, url) {
  const expected = Buffer.from(String(config.dashboard.token));
  const given = Buffer.from(String(tokenOf(req, url)));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function snapshot() {
  const client = clientRef;
  const ai = budget.status();
  const guilds = client?.guilds?.cache ? [...client.guilds.cache.values()] : [];
  return {
    uptime: Date.now() - startedAt,
    uptimeLabel: formatDuration(Date.now() - startedAt),
    ready: Boolean(client?.isReady?.()),
    ping: client?.ws?.ping ?? null,
    guilds: guilds.map((guild) => {
      const guildData = store.data.guilds?.[guild.id] ?? {};
      return {
        id: guild.id,
        name: guild.name,
        members: guild.memberCount,
        openTickets: Object.values(guildData.tickets ?? {}).filter((ticket) => !ticket.closedAt).length,
        openAppeals: Object.values(guildData.appeals?.items ?? {}).filter((appeal) => appeal.status === 'open').length,
      };
    }),
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
  };
}

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

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

function renderPage(data) {
  const totals = data.guilds.reduce(
    (sum, guild) => ({
      members: sum.members + guild.members,
      openTickets: sum.openTickets + guild.openTickets,
      openAppeals: sum.openAppeals + guild.openAppeals,
    }),
    { members: 0, openTickets: 0, openAppeals: 0 },
  );

  const guildRows = data.guilds
    .map(
      (guild) => `<tr>
        <td class="server"><span class="dot"></span>${escape(guild.name)}</td>
        <td>${fmt(guild.members)}</td>
        <td><span class="pill ${guild.openTickets ? 'info' : 'muted'}">${fmt(guild.openTickets)}</span></td>
        <td><span class="pill ${guild.openAppeals ? 'warn' : 'muted'}">${fmt(guild.openAppeals)}</span></td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScoutBot dashboard</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d13;
    --panel: rgba(22, 26, 38, 0.72);
    --border: rgba(255, 255, 255, 0.08);
    --text: #e6e9f2;
    --muted: #8b93a7;
    --accent: #5865f2;
    --accent-2: #8b5cf6;
    --ok: #3ba55d;
    --warn: #faa61a;
    --danger: #ed4245;
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; min-height: 100vh; color: var(--text);
    background:
      radial-gradient(900px 500px at 12% -10%, rgba(88, 101, 242, 0.22), transparent 60%),
      radial-gradient(800px 500px at 100% 0%, rgba(139, 92, 246, 0.16), transparent 55%),
      var(--bg);
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 40px 24px 56px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 32px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo {
    width: 46px; height: 46px; border-radius: 13px; display: grid; place-items: center;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 8px 24px rgba(88, 101, 242, 0.35); font-size: 24px;
  }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  .subtitle { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .status {
    display: inline-flex; align-items: center; gap: 9px; padding: 9px 16px; border-radius: 999px;
    background: var(--panel); border: 1px solid var(--border); font-size: 13px; font-weight: 600;
    backdrop-filter: blur(10px);
  }
  .status .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  .status.online .dot { background: var(--ok); box-shadow: 0 0 0 0 rgba(59, 165, 93, 0.7); animation: pulse 2s infinite; }
  .status.offline .dot { background: var(--danger); }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(59, 165, 93, 0.5); }
    70% { box-shadow: 0 0 0 10px rgba(59, 165, 93, 0); }
    100% { box-shadow: 0 0 0 0 rgba(59, 165, 93, 0); }
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 20px;
    backdrop-filter: blur(12px); transition: transform 0.15s ease, border-color 0.15s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: rgba(88, 101, 242, 0.45); }
  .card .label {
    display: flex; align-items: center; gap: 8px; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--muted); margin-bottom: 12px; font-weight: 600;
  }
  .card .label .icon { font-size: 15px; }
  .card .value { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
  .card .hint { margin-top: 6px; font-size: 12px; color: var(--muted); }
  .section { margin-top: 28px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .section-head h2 { font-size: 15px; margin: 0; letter-spacing: -0.01em; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 22px; backdrop-filter: blur(12px); }
  .ai-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 22px; }
  .ai-item .top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .ai-item .name { font-size: 13px; color: var(--muted); font-weight: 600; }
  .ai-item .num { font-size: 15px; font-weight: 700; }
  .bar { height: 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width 0.4s ease; }
  .bar.warn span { background: linear-gradient(90deg, #f0a020, var(--warn)); }
  .bar.danger span { background: linear-gradient(90deg, #e14b4b, var(--danger)); }
  .ai-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .ai-actions .state { font-size: 13px; color: var(--muted); }
  .ai-actions .state strong { color: var(--text); }
  button {
    font: inherit; font-weight: 600; color: #fff; border: 0; border-radius: 10px; padding: 10px 18px;
    cursor: pointer; background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 6px 18px rgba(88, 101, 242, 0.3); transition: filter 0.15s ease, transform 0.1s ease;
  }
  button:hover { filter: brightness(1.1); }
  button:active { transform: translateY(1px); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 13px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
  thead th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: rgba(255, 255, 255, 0.03); }
  td.server { font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .pill { display: inline-block; min-width: 30px; text-align: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .pill.info { background: rgba(88, 101, 242, 0.18); color: #a5b4fc; }
  .pill.warn { background: rgba(250, 166, 26, 0.16); color: var(--warn); }
  .pill.muted { background: rgba(255, 255, 255, 0.06); color: var(--muted); }
  footer { margin-top: 28px; text-align: center; font-size: 12px; color: var(--muted); }
  footer .dot { display: inline-block; margin-right: 6px; background: var(--ok); animation: pulse 2s infinite; }
  @media (max-width: 560px) {
    .wrap { padding: 24px 16px 40px; }
    header { flex-direction: column; align-items: flex-start; }
    .card .value { font-size: 24px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo">🛰️</div>
      <div>
        <h1>ScoutBot</h1>
        <p class="subtitle">Control panel</p>
      </div>
    </div>
    <div class="status ${data.ready ? 'online' : 'offline'}" id="status">
      <span class="dot"></span><span id="status-text">${data.ready ? 'Online' : 'Offline'}</span>
    </div>
  </header>

  <div class="grid">
    <div class="card">
      <div class="label"><span class="icon">⏱️</span>Uptime</div>
      <div class="value" id="uptime">${escape(data.uptimeLabel)}</div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">📡</span>Ping</div>
      <div class="value" id="ping">${data.ping ?? '—'} <span style="font-size:14px;color:var(--muted)">ms</span></div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">🧩</span>Commands</div>
      <div class="value" id="commands">${fmt(data.commands)}</div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">💾</span>Memory</div>
      <div class="value" id="memory">${data.memoryMb} <span style="font-size:14px;color:var(--muted)">MB</span></div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">👥</span>Members</div>
      <div class="value" id="members">${fmt(totals.members)}</div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">🎫</span>Open tickets</div>
      <div class="value" id="tickets">${fmt(totals.openTickets)}</div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">📨</span>Open appeals</div>
      <div class="value" id="appeals">${fmt(totals.openAppeals)}</div>
    </div>
    <div class="card">
      <div class="label"><span class="icon">🤖</span>AI model</div>
      <div class="value" style="font-size:18px" id="model">${escape(data.ai.model)}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-head"><h2>AI usage today</h2></div>
    <div class="panel">
      <div class="ai-row">
        <div class="ai-item">
          <div class="top">
            <span class="name">Tokens</span>
            <span class="num" id="tokens-label">${fmt(data.ai.tokensToday)}${data.ai.dailyLimit ? ` / ${fmt(data.ai.dailyLimit)}` : ''}</span>
          </div>
          <div id="tokens-bar">${bar(data.ai.tokensToday, data.ai.dailyLimit)}</div>
        </div>
        <div class="ai-item">
          <div class="top">
            <span class="name">Images</span>
            <span class="num" id="images-label">${fmt(data.ai.imagesToday)}${data.ai.imageLimit ? ` / ${fmt(data.ai.imageLimit)}` : ''}</span>
          </div>
          <div id="images-bar">${bar(data.ai.imagesToday, data.ai.imageLimit)}</div>
        </div>
        <div class="ai-item">
          <div class="top">
            <span class="name">API calls</span>
            <span class="num" id="calls-label">${fmt(data.ai.callsToday)}</span>
          </div>
          <div class="bar"><span style="width:0%"></span></div>
        </div>
      </div>
      <div class="ai-actions">
        <div class="state">AI is currently <strong id="ai-state">${data.ai.paused ? 'paused' : 'active'}</strong></div>
        <button id="toggle" data-paused="${data.ai.paused ? 'true' : 'false'}">${data.ai.paused ? 'Resume AI' : 'Pause AI'}</button>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-head"><h2>Servers</h2></div>
    <div class="panel" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>Server</th><th>Members</th><th>Open tickets</th><th>Open appeals</th></tr></thead>
        <tbody>${guildRows || '<tr><td colspan="4" style="color:var(--muted)">No server connected yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <footer><span class="dot"></span>Auto-refreshing every 10 seconds</footer>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

function barHtml(value, limit) {
  if (!limit || !isFinite(limit) || limit <= 0) return '';
  const percent = Math.max(0, Math.min(100, Math.round((value / limit) * 100)));
  const tone = percent >= 100 ? 'danger' : percent >= 80 ? 'warn' : '';
  return '<div class="bar ' + tone + '"><span style="width:' + percent + '%"></span></div>';
}

function apply(data) {
  const status = document.getElementById('status');
  status.classList.toggle('online', data.ready);
  status.classList.toggle('offline', !data.ready);
  document.getElementById('status-text').textContent = data.ready ? 'Online' : 'Offline';
  document.getElementById('uptime').textContent = data.uptimeLabel;
  document.getElementById('ping').innerHTML = (data.ping == null ? '—' : data.ping) + ' <span style="font-size:14px;color:var(--muted)">ms</span>';
  document.getElementById('commands').textContent = fmt(data.commands);
  document.getElementById('memory').innerHTML = data.memoryMb + ' <span style="font-size:14px;color:var(--muted)">MB</span>';
  document.getElementById('model').textContent = data.ai.model;

  const totals = data.guilds.reduce((sum, g) => ({
    members: sum.members + g.members,
    openTickets: sum.openTickets + g.openTickets,
    openAppeals: sum.openAppeals + g.openAppeals,
  }), { members: 0, openTickets: 0, openAppeals: 0 });
  document.getElementById('members').textContent = fmt(totals.members);
  document.getElementById('tickets').textContent = fmt(totals.openTickets);
  document.getElementById('appeals').textContent = fmt(totals.openAppeals);

  document.getElementById('tokens-label').textContent = fmt(data.ai.tokensToday) + (data.ai.dailyLimit ? ' / ' + fmt(data.ai.dailyLimit) : '');
  document.getElementById('images-label').textContent = fmt(data.ai.imagesToday) + (data.ai.imageLimit ? ' / ' + fmt(data.ai.imageLimit) : '');
  document.getElementById('calls-label').textContent = fmt(data.ai.callsToday);
  document.getElementById('tokens-bar').innerHTML = barHtml(data.ai.tokensToday, data.ai.dailyLimit);
  document.getElementById('images-bar').innerHTML = barHtml(data.ai.imagesToday, data.ai.imageLimit);

  document.getElementById('ai-state').textContent = data.ai.paused ? 'paused' : 'active';
  const toggle = document.getElementById('toggle');
  toggle.textContent = data.ai.paused ? 'Resume AI' : 'Pause AI';
  toggle.dataset.paused = data.ai.paused ? 'true' : 'false';
}

async function refresh() {
  try {
    const res = await fetch('/api/status?token=' + encodeURIComponent(token), { cache: 'no-store' });
    if (res.ok) apply(await res.json());
  } catch (err) { /* keep showing the last known state */ }
}

document.getElementById('toggle').addEventListener('click', async () => {
  const paused = document.getElementById('toggle').dataset.paused !== 'true';
  const res = await fetch('/api/ai/pause?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: paused }),
  });
  if (res.ok) refresh();
  else alert('Request failed: ' + res.status);
});

setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function start(client) {
  clientRef = client;
  if (!config.dashboard.token) return;
  if (server) return;

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!authorized(req, url)) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, renderPage(snapshot()), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return send(res, 200, JSON.stringify(snapshot(), null, 2), 'application/json; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/pause') {
        const body = await readJson(req);
        if (typeof body.paused !== 'boolean') return send(res, 400, '{"error":"paused must be a boolean"}', 'application/json');
        budget.setPaused(body.paused);
        return send(res, 200, JSON.stringify({ paused: body.paused }), 'application/json; charset=utf-8');
      }
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }), 'application/json; charset=utf-8');
    }
  });

  server.on('error', (err) => console.error('[dashboard] failed:', err.message));
  server.listen(config.dashboard.port, () => {
    console.log(`Dashboard listening on port ${config.dashboard.port} (token required)`);
  });
}

module.exports = { start, snapshot, renderPage };
