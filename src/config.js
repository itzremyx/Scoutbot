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
    owner: {
      name: 'Gentra',
      id: process.env.BOT_OWNER_ID || '1561860035158736898',
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
      imageModel: process.env.AI_IMAGE_MODEL || 'openai-gpt-5-image',
      imageBaseUrl,
      imageEndpoint: process.env.AI_IMAGE_ENDPOINT || '/images/generations',
      imageApiKey: process.env.AI_IMAGE_API_KEY || process.env.AI_API_KEY,
      imageDailyLimit: envNumber('AI_IMAGE_DAILY_LIMIT', 50),
      imagePerUserLimit: envNumber('AI_IMAGE_PER_USER_LIMIT', 2),
      imageTimeoutMs: 120_000,
      dailyTokenLimit: envNumber('AI_DAILY_TOKEN_LIMIT', 1_000_000),
      cooldownSeconds: envNumber('AI_COOLDOWN_SECONDS', 5),
    },
    aiChannelId: process.env.AI_CHANNEL_ID || '1566503029916700752',
    updateChannelId: process.env.UPDATE_CHANNEL_ID || '1566490353748680814',
    changelogChannelId: process.env.CHANGELOG_CHANNEL_ID || '1566490537006202880',
    botRepoChannelId: process.env.BOT_REPO_CHANNEL_ID || '1567292394116751390',
    // Role given to every member who joins (set by /role all; 0 = disabled).
    autoRoleId: process.env.AUTO_ROLE_ID || '1566953972290289764',
    dataFile: path.join(__dirname, '..', 'data', 'store.json'),
    transcriptDir: path.join(__dirname, '..', 'data', 'transcripts'),
  };
}

const config = buildConfig();

// Reload environment-backed values without creating a second config object in modules that require it.
config.reload = () => {
  dotenv.config({ path: envPath, override: true });
  Object.assign(config, buildConfig());
  return config;
};

module.exports = config;
