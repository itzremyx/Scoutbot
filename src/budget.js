const config = require('./config');
const health = require('./health');
const store = require('./storage');

const lastRequest = new Map();
const today = () => new Date().toISOString().slice(0, 10);

function state() {
  const budget = (store.data.budget ??= {
    paused: false,
    dailyLimit: null,
    cooldownSeconds: null,
    day: today(),
    tokensToday: 0,
    callsToday: 0,
    imageCallsToday: 0,
    imageDailyLimit: null,
    imageUsers: {},
    totalTokens: 0,
    totalCalls: 0,
    totalImageCalls: 0,
  });
  budget.imageUsers ??= {};
  budget.alerted ??= {};
  if (budget.day !== today()) {
    budget.day = today();
    budget.tokensToday = 0;
    budget.callsToday = 0;
    budget.imageCallsToday = 0;
    budget.imageUsers = {};
    budget.alerted = {};
  }
  return budget;
}

const limit = () => {
  const value = state().dailyLimit ?? config.ai.dailyTokenLimit;
  return value === 0 ? Infinity : value;
};
const imageLimit = () => {
  const value = state().imageDailyLimit ?? config.ai.imageDailyLimit;
  return value === 0 ? Infinity : value;
};
const perUserImageLimit = () => {
  const value = config.ai.imagePerUserLimit;
  return value === 0 ? Infinity : value;
};
const cooldownSeconds = () => state().cooldownSeconds ?? config.ai.cooldownSeconds;

function assertAvailable() {
  const budget = state();
  if (budget.paused) throw new Error('The AI is paused right now. Try again later.');
  if (budget.tokensToday >= limit()) throw new Error('The AI has reached its daily limit. It resets at 00:00 UTC.');
}

function checkCooldown(userId) {
  const cooldownMs = cooldownSeconds() * 1000;
  const now = Date.now();
  const elapsed = now - (lastRequest.get(userId) ?? 0);
  if (elapsed < cooldownMs) {
    throw new Error(`Slow down! You can ask me again in ${Math.ceil((cooldownMs - elapsed) / 1000)}s.`);
  }
  lastRequest.set(userId, now);
  if (lastRequest.size > 5000) {
    for (const [id, time] of lastRequest) if (now - time >= cooldownMs) lastRequest.delete(id);
  }
}

// DMs the owner once per UTC day when the token or image budget crosses 80% and 100%.
function maybeAlert(budget) {
  const alerted = budget.alerted;
  const notify = (flag, title, description) => {
    if (alerted[flag]) return;
    alerted[flag] = true;
    health.alertOwner(title, description, { key: `ai-budget-${flag}` }).catch(() => {});
  };

  const tokenLimit = limit();
  if (Number.isFinite(tokenLimit) && tokenLimit > 0) {
    const ratio = budget.tokensToday / tokenLimit;
    if (ratio >= 1) {
      notify('tokens100', 'AI daily token limit reached', `Today's AI usage is at ${budget.tokensToday.toLocaleString('en-US')} of ${tokenLimit.toLocaleString('en-US')} tokens. Further requests are blocked until 00:00 UTC.`);
    } else if (ratio >= 0.8) {
      notify('tokens80', 'AI daily token budget at 80%', `Today's AI usage is at ${budget.tokensToday.toLocaleString('en-US')} of ${tokenLimit.toLocaleString('en-US')} tokens.`);
    }
  }

  const images = imageLimit();
  if (Number.isFinite(images) && images > 0) {
    if (budget.imageCallsToday >= images) {
      notify('images100', 'AI daily image limit reached', `Today's image usage is at ${budget.imageCallsToday} of ${images}. Further image requests are blocked until 00:00 UTC.`);
    } else if (budget.imageCallsToday / images >= 0.8) {
      notify('images80', 'AI daily image budget at 80%', `Today's image usage is at ${budget.imageCallsToday} of ${images}.`);
    }
  }
}

function record(tokens) {
  const budget = state();
  budget.tokensToday += tokens;
  budget.callsToday += 1;
  budget.totalTokens += tokens;
  budget.totalCalls += 1;
  store.save();
  maybeAlert(budget);
}

function userImageCount(userId) {
  state();
  return Number(state().imageUsers[String(userId)] ?? 0);
}

function assertImagesAvailable(userId, count = 1) {
  const budget = state();
  if (budget.paused) throw new Error('The AI is paused right now. Try again later.');
  if (budget.imageCallsToday + count > imageLimit()) {
    throw new Error('The daily image limit is reached. It resets at 00:00 UTC.');
  }
  if (userId !== undefined && userImageCount(userId) + count > perUserImageLimit()) {
    throw new Error(`You can generate only ${perUserImageLimit()} image(s) per day. Your limit resets at 00:00 UTC.`);
  }
}

function canGenerateImages(n, userId) {
  const budget = state();
  if (budget.paused || budget.imageCallsToday + n > imageLimit()) return false;
  return userId === undefined || userImageCount(userId) + n <= perUserImageLimit();
}

function imagesLeft(userId) {
  const remainingDaily = imageLimit() === Infinity ? Infinity : Math.max(0, imageLimit() - state().imageCallsToday);
  if (userId === undefined) return remainingDaily;
  const remainingUser = perUserImageLimit() === Infinity ? Infinity : Math.max(0, perUserImageLimit() - userImageCount(userId));
  return Math.min(remainingDaily, remainingUser);
}

function recordImages(count, userId) {
  const budget = state();
  budget.callsToday += count;
  budget.totalCalls += count;
  budget.imageCallsToday += count;
  budget.totalImageCalls += count;
  if (userId !== undefined) budget.imageUsers[String(userId)] = userImageCount(userId) + count;
  store.save();
  maybeAlert(budget);
}

function status(userId) {
  const budget = state();
  return {
    paused: budget.paused,
    limit: limit(),
    imageLimit: imageLimit(),
    imagePerUserLimit: perUserImageLimit(),
    userImageCallsToday: userId === undefined ? null : userImageCount(userId),
    userImagesLeft: userId === undefined ? null : imagesLeft(userId),
    cooldownSeconds: cooldownSeconds(),
    tokensToday: budget.tokensToday,
    callsToday: budget.callsToday,
    imageCallsToday: budget.imageCallsToday,
    totalTokens: budget.totalTokens,
    totalCalls: budget.totalCalls,
    totalImageCalls: budget.totalImageCalls,
    day: budget.day,
  };
}

function setLimit(tokens) { state().dailyLimit = tokens; store.save(); }
function setImageLimit(images) { state().imageDailyLimit = images; store.save(); }
function setCooldown(seconds) { state().cooldownSeconds = seconds; store.save(); }
function setPaused(paused) { state().paused = paused; store.save(); }
function resetToday() { const budget = state(); budget.tokensToday = 0; budget.callsToday = 0; budget.imageCallsToday = 0; budget.imageUsers = {}; store.save(); }

module.exports = {
  assertAvailable,
  assertImagesAvailable,
  canGenerateImages,
  checkCooldown,
  imagesLeft,
  perUserImageLimit,
  record,
  recordImages,
  status,
  setLimit,
  setImageLimit,
  setCooldown,
  setPaused,
  resetToday,
};
