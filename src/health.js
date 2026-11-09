const { EmbedBuilder, Events } = require('discord.js');
const config = require('./config');

const ALERT_THROTTLE_MS = 30 * 60_000;
const AI_PROBE_MS = 15 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const GATEWAY_GRACE_MS = 5 * 60_000;

const lastAlert = new Map();
let clientRef = null;

function alertEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️ ${title}`)
    .setDescription(String(description || '').slice(0, 3900))
    .setFooter({ text: 'ScoutBot health alert' })
    .setTimestamp();
}

// Optional external webhook: works even before Discord login, which is the only channel that
// can report a failed login. Configure ALERT_WEBHOOK_URL with a Discord webhook URL.
async function postWebhook(title, description) {
  if (!config.alertWebhookUrl) return false;
  try {
    const response = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `⚠️ **${title}**\n${String(description || '').slice(0, 1800)}`,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch (err) {
    console.error('[health] webhook alert failed:', err.message);
    return false;
  }
}

// Sends one alert to the bot owner (DM) and/or the external webhook. Identical alerts are
// throttled so a repeated failure cannot flood the owner; pass force to bypass the throttle.
async function alertOwner(title, description, { key = title, force = false } = {}) {
  const now = Date.now();
  if (!force && now - (lastAlert.get(key) || 0) < ALERT_THROTTLE_MS) return false;
  lastAlert.set(key, now);

  const body = String(description || '').slice(0, 1900);
  let delivered = await postWebhook(title, body);

  const client = clientRef;
  if (client?.isReady?.()) {
    const owner = await client.users.fetch(config.owner.id).catch(() => null);
    if (owner) {
      const sent = await owner.send({ embeds: [alertEmbed(title, body)] })
        .then(() => true)
        .catch(() => false);
      delivered = delivered || sent;
    }
  }

  if (!delivered) console.error('[health] owner alert not delivered:', title);
  return delivered;
}

// GET /models is a cheap reachability check: any HTTP answer except 401/403 means the endpoint
// answers (a 404 is fine, not every provider exposes /models).
async function probeAi() {
  if (!config.ai.apiKey) return { ok: false, reason: 'AI_API_KEY is missing from the .env file.' };
  try {
    const response = await fetch(`${config.ai.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, auth: true, reason: `The AI API rejected the key (HTTP ${response.status}).` };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, reason: `The AI endpoint is unreachable: ${err.message}` };
  }
}

function register(client) {
  clientRef = client;

  let aiFailures = 0;
  let recoveryPending = false;
  let gatewayDownSince = null;

  const checkAi = async () => {
    if (!client.isReady()) return;
    const probe = await probeAi();
    if (probe.ok) {
      if (recoveryPending) {
        recoveryPending = false;
        await alertOwner('AI endpoint recovered', `The AI API answers again (${config.ai.baseUrl}).`, { key: 'ai', force: true });
      }
      aiFailures = 0;
      return;
    }

    aiFailures += 1;
    if (aiFailures < 2) return; // ignore a single blip
    recoveryPending = true;
    await alertOwner(
      probe.auth ? 'AI authentication failed' : 'AI endpoint unreachable',
      `${probe.reason}\n\nEndpoint: ${config.ai.baseUrl}`,
      { key: 'ai' },
    );
  };

  const checkGateway = async () => {
    if (client.isReady()) {
      gatewayDownSince = null;
      return;
    }
    const now = Date.now();
    if (!gatewayDownSince) {
      gatewayDownSince = now;
      return;
    }
    if (now - gatewayDownSince >= GATEWAY_GRACE_MS) {
      await alertOwner('Bot gateway is not ready', `The Discord connection has been down for over ${Math.round(GATEWAY_GRACE_MS / 60_000)} minutes.`, { key: 'gateway' });
    }
  };

  client.once(Events.ClientReady, () => {
    setTimeout(() => checkAi().catch(() => {}), 20_000);
  });

  setInterval(() => {
    checkGateway().catch(() => {});
    checkAi().catch(() => {});
  }, AI_PROBE_MS);

  if (config.healthcheckUrl) {
    const beat = () => fetch(config.healthcheckUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    client.once(Events.ClientReady, beat);
    setInterval(beat, HEARTBEAT_MS);
  }
}

module.exports = {
  register,
  alertOwner,
  probeAi,
  status: () => ({
    lastAlerts: [...lastAlert.entries()].map(([key, at]) => ({ key, at })).sort((a, b) => b.at - a.at),
    tracked: lastAlert.size,
  }),
  notify: (title, description, options) => alertOwner(title, description, options),
};
