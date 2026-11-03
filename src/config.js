const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Reads a number from .env, or returns the fallback when the variable is empty or not a number.
const envNumber = (name, fallback) => {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : fallback;
};

const chatBaseUrl = (process.env.AI_BASE_URL || 'https://scoutcode.dev/v1').replace(/\/+$/, '');
const imageBaseUrl = (process.env.AI_IMAGE_BASE_URL || chatBaseUrl).replace(/\/+$/, '');

module.exports = {
  token: process.env.DISCORD_TOKEN,

  owner: { name: 'Gentra' },

  // Used until someone changes it with /personality set.
  defaultPersonality: 'You are a friendly, helpful Discord bot. Keep answers clear and concise.',

  ai: {
    apiKey: process.env.AI_API_KEY,
    baseUrl: chatBaseUrl,
    model: process.env.AI_MODEL || 'minimax-m3.1-flash',
    // Tried automatically whenever the primary model fails for any reason (rejected model,
    // timeout, rate limit, outage). Same endpoint and API key; never on 401/403 (bad key).
    fallbackModel: process.env.AI_MODEL_FALLBACK || 'minimax-m3.1-flash',
    // low | medium | high | xhigh | max. Empty string disables it (only MiniMax-M3.1-Flash accepts it).
    reasoningEffort: process.env.AI_REASONING_EFFORT ?? 'medium',
    // Thinking tokens count toward this limit, so keep it well above the answer length.
    maxTokens: 2048,
    // Reasoning models (MiniMax, DeepSeek) think before answering; 60s was too short and cut answers off.
    timeoutMs: 180_000,
    // /imagine: ScoutCode's GPT-5 Image endpoint by default.
    imageModel: process.env.AI_IMAGE_MODEL || 'openai-gpt-5-image',
    imageBaseUrl,
    imageEndpoint: process.env.AI_IMAGE_ENDPOINT || '/images/generations',
    // ScoutCode uses the same API key for chat and image generation by default.
    imageApiKey: process.env.AI_IMAGE_API_KEY || process.env.AI_API_KEY,
    imageDailyLimit: envNumber('AI_IMAGE_DAILY_LIMIT', 50),
    imageTimeoutMs: 120_000,
    // Budget: total tokens per UTC day, and seconds a user must wait between AI requests.
    dailyTokenLimit: envNumber('AI_DAILY_TOKEN_LIMIT', 1_000_000),
    cooldownSeconds: envNumber('AI_COOLDOWN_SECONDS', 5),
  },

  // Dedicated channel where every message is a question (no mention needed).
  aiChannelId: process.env.AI_CHANNEL_ID || '1566503029916700752',

  // ScoutCode release announcements (see src/updates.js).
  updateChannelId: process.env.UPDATE_CHANNEL_ID || '1566490353748680814',
  changelogChannelId: process.env.CHANGELOG_CHANNEL_ID || '1566490537006202880',

  dataFile: path.join(__dirname, '..', 'data', 'store.json'),
  transcriptDir: path.join(__dirname, '..', 'data', 'transcripts'),
};
