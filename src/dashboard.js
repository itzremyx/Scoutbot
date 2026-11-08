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

function renderPage(data) {
  const guildRows = data.guilds
    .map(
      (guild) =>
        `<tr><td>${escape(guild.name)}</td><td>${guild.members}</td><td>${guild.openTickets}</td><td>${guild.openAppeals}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScoutBot dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 32px; }
  h1 { color: #569cd6; margin-top: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #252526; border: 1px solid #333; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #858585; margin: 0 0 8px; }
  .value { font-size: 24px; color: #ce9178; }
  table { width: 100%; border-collapse: collapse; background: #252526; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #333; }
  th { color: #858585; font-weight: 500; }
  button { background: #0e639c; color: #fff; border: 0; border-radius: 4px; padding: 8px 14px; font: inherit; cursor: pointer; }
  button:hover { background: #1177bb; }
  .ok { color: #57f287; } .bad { color: #ed4245; }
</style>
</head>
<body>
<h1>ScoutBot dashboard</h1>
<div class="grid">
  <div class="card"><h2>Status</h2><div class="value ${data.ready ? 'ok' : 'bad'}">${data.ready ? 'Online' : 'Offline'}</div></div>
  <div class="card"><h2>Uptime</h2><div class="value">${escape(data.uptimeLabel)}</div></div>
  <div class="card"><h2>Ping</h2><div class="value">${data.ping ?? 'n/a'} ms</div></div>
  <div class="card"><h2>Commands</h2><div class="value">${data.commands}</div></div>
  <div class="card"><h2>Memory</h2><div class="value">${data.memoryMb} MB</div></div>
  <div class="card"><h2>AI model</h2><div class="value">${escape(data.ai.model)}</div></div>
  <div class="card"><h2>Tokens today</h2><div class="value">${data.ai.tokensToday.toLocaleString('en-US')}${data.ai.dailyLimit ? ` / ${data.ai.dailyLimit.toLocaleString('en-US')}` : ''}</div></div>
  <div class="card"><h2>Images today</h2><div class="value">${data.ai.imagesToday}${data.ai.imageLimit ? ` / ${data.ai.imageLimit}` : ''}</div></div>
</div>
<p>AI is <strong>${data.ai.paused ? 'paused' : 'active'}</strong>. <button id="toggle">${data.ai.paused ? 'Resume AI' : 'Pause AI'}</button></p>
<table>
  <thead><tr><th>Server</th><th>Members</th><th>Open tickets</th><th>Open appeals</th></tr></thead>
  <tbody>${guildRows || '<tr><td colspan="4">No server connected yet.</td></tr>'}</tbody>
</table>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
document.getElementById('toggle').addEventListener('click', async () => {
  const paused = ${data.ai.paused ? 'false' : 'true'};
  const res = await fetch('/api/ai/pause?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  });
  if (res.ok) location.reload();
  else alert('Request failed: ' + res.status);
});
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
