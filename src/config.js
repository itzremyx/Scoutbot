const path = require('path');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const envNumber = (name, fallback) => {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : fallback;
};

function buildConfig() {
  const chatBaseUrl = (process.env.AI_BASE_URL || 'https://scoutcode.dev/v1').replace(/\/+$/, '');
  const imageBaseUrl = (process.env.AI_IMAGE_BASE_URL || chatBaseUrl).replace(/\/+$/, '');
  return {
    token: process.env.DISCORD_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    discordBotSecret: process.env.DISCORD_BOT_SECRET || '',
    siteUrl: (process.env.SCOUTCODE_SITE_URL || (process.env.AI_BASE_URL || 'https://scoutcode.dev/v1').replace(/\/v1\/?$/, '')).replace(/\/+$/, ''),
    owner: {
      name: 'Gentra',
      id: process.env.BOT_OWNER_ID || '1561860035158736898',
    },
    // The single Discord server this installation runs for. Used to register slash commands
    // and as the fallback target for DM appeals.
    mainGuildId: process.env.MAIN_GUILD_ID || '1565465623910424586',
    // Health alerts: a Discord webhook (works even before login) and an optional external
    // heartbeat URL (e.g. healthchecks.io) pinged every 5 minutes.
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    healthcheckUrl: process.env.HEALTHCHECK_URL || '',
    // Minimal read-only status dashboard. Disabled unless a token is set.
    dashboard: {
      port: envNumber('DASHBOARD_PORT', 3000),
      token: process.env.DASHBOARD_TOKEN || '',
    },
    defaultPersonality: 'You are a friendly, helpful Discord bot. Keep answers clear and concise.',
    ai: {
      apiKey: process.env.AI_API_KEY,
      baseUrl: chatBaseUrl,
      model: process.env.AI_MODEL || 'minimax-m3.1-flash',
      fallbackModel: process.env.AI_MODEL_FALLBACK || 'minimax-m3.1-flash',
      visionModel: process.env.AI_VISION_MODEL || 'auto',
      reasoningEffort: process.env.AI_REASONING_EFFORT ?? 'medium',
      maxTokens: 2048,
      timeoutMs: 180_000,
      imageModel: process.env.AI_IMAGE_MODEL || 'gpt-5-mini-image',
      imageBaseUrl,
      imageEndpoint: process.env.AI_IMAGE_ENDPOINT || '/images/generations',
      imageApiKey: process.env.AI_IMAGE_API_KEY || process.env.AI_API_KEY,
      imageDailyLimit: envNumber('AI_IMAGE_DAILY_LIMIT', 50),
      imagePerUserLimit: envNumber('AI_IMAGE_PER_USER_LIMIT', 2),
      imageTimeoutMs: 120_000,
      dailyTokenLimit: envNumber('AI_DAILY_TOKEN_LIMIT', 1_000_000),
      cooldownSeconds: envNumber('AI_COOLDOWN_SECONDS', 5),
    },
    aiChannelId: process.env.AI_CHANNEL_ID || '1568689660245450993',
    updateChannelId: process.env.UPDATE_CHANNEL_ID || '1566490353748680814',
    changelogChannelId: process.env.CHANGELOG_CHANNEL_ID || '1566490537006202880',
    botRepoChannelId: process.env.BOT_REPO_CHANNEL_ID || '1568689855284777144',
    // Forum channel used by /suggest.
    suggestionChannelId: process.env.SUGGESTION_CHANNEL_ID || '1566492469393227866',
    // Role given to every member who joins (set by /role all; 0 = disabled).
    autoRoleId: process.env.AUTO_ROLE_ID || '1566953972290289764',
    // ScoutRadio: rename the voice channel while a track plays, and feed YouTube either a
    // cookies string or a cookies file (only needed for age-restricted / members-only links).
    radio: {
      renameChannel: process.env.RADIO_RENAME_CHANNEL !== 'false',
      channelPrefix: process.env.RADIO_CHANNEL_PREFIX || 'Radio',
      youtubeCookies: process.env.YOUTUBE_COOKIES || '',
      cookiesFile: process.env.YTDLP_COOKIES_FILE || '',
    },
    dataFile: process.env.SCOUT_DATA_FILE || path.join(__dirname, '..', 'data', 'store.json'),
    transcriptDir: path.join(__dirname, '..', 'data', 'transcripts'),
  };
}

let config = buildConfig();

// /setup stores these on the single server the bot runs for, and they win over the .env defaults
// so a change applies on the next read without editing the environment or restarting.
const storeOverrides = { aiChannelId: 'aiChannelId', botRepoChannelId: 'botRepoChannelId', autoRoleId: 'autoRoleId' };

// The .env fallbacks are kept aside instead of being read from `config` itself, because the
// getters below overwrite those keys on `config`: a reload has to update the fallbacks, not try
// to assign a getter-only property (that throws "has only a getter").
let fallbacks = {};
function applyStoreGetters(source) {
  for (const [key, storeKey] of Object.entries(storeOverrides)) {
    fallbacks[key] = source[key];
    Object.defineProperty(config, key, {
      configurable: true,
      enumerable: true,
      get() {
        const saved = require('./storage').data.settings?.[storeKey];
        return saved ? String(saved) : fallbacks[key];
      },
    });
  }
}
applyStoreGetters(config);

// Reload environment-backed values without creating a second config object in modules that require it.
config.reload = () => {
  dotenv.config({ path: envPath, override: true });
  const fresh = buildConfig();
  const overridden = new Set(Object.keys(storeOverrides));
  for (const [key, value] of Object.entries(fresh)) {
    if (!overridden.has(key)) config[key] = value;
  }
  applyStoreGetters(fresh);
  return config;
};

module.exports = config;
