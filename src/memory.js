const store = require('./storage');

const MAX_FACTS = 50;
const MAX_INSTRUCTIONS = 50;
const MAX_PENDING = 50;

// Long-term facts the bot keeps about each user, shared across all servers and DMs.

function getFacts(userId) {
  return store.data.users[userId]?.facts ?? [];
}

function addFact(userId, text) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;

  const record = (store.data.users[userId] ??= { nextFactId: 1, facts: [] });
  if (record.facts.some((fact) => fact.text.toLowerCase() === clean.toLowerCase())) return null;

  const fact = { id: record.nextFactId++, text: clean, createdAt: Date.now() };
  record.facts.push(fact);
  if (record.facts.length > MAX_FACTS) record.facts.shift(); // forget the oldest first
  store.save();
  return fact;
}

// A fact the bot learned on its own goes live immediately (no admin approval step).
// `replaces` is an outdated fact id: it is dropped first, and an empty `text` only removes it.
// Returns the saved fact, true when only a removal happened, or null when nothing changed.
function learnFact(_guildId, userId, text, replaces = null) {
  const replaceId = replaces !== null && getFacts(userId).some((fact) => fact.id === replaces) ? replaces : null;
  if (replaceId !== null) removeFact(userId, replaceId);
  if (!text) return replaceId !== null ? true : null;
  return addFact(userId, text);
}

function removeFact(userId, factId) {
  const facts = store.data.users[userId]?.facts ?? [];
  const index = facts.findIndex((fact) => fact.id === factId);
  if (index === -1) return false;

  facts.splice(index, 1);
  store.save();
  return true;
}

function clearFacts(userId) {
  if (!store.data.users[userId]) return;
  store.data.users[userId].facts = [];
  store.save();
}

// Facts the bot learned on its own wait here until a server admin approves them. A pending item
// may replace an outdated fact (replaces = its id), or only remove one (text = null).
function getPending(guildId) {
  return store.guild(guildId).pendingFacts ?? [];
}

function addPendingFact(guildId, userId, text, replaces = null) {
  const clean = text ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  if (!clean && replaces === null) return null;
  if (replaces !== null && !getFacts(userId).some((fact) => fact.id === replaces)) return null;

  const guild = store.guild(guildId);
  guild.pendingFacts ??= [];
  guild.nextPendingId ??= 1;
  const lower = clean?.toLowerCase() ?? null;
  if (guild.pendingFacts.some((item) => item.userId === userId && (item.text?.toLowerCase() ?? null) === lower && item.replaces === replaces)) {
    return null;
  }
  if (lower && getFacts(userId).some((fact) => fact.text.toLowerCase() === lower)) return null;
  if (guild.pendingFacts.length >= MAX_PENDING) return 'full';

  const item = { id: guild.nextPendingId++, userId, text: clean, replaces, createdAt: Date.now() };
  guild.pendingFacts.push(item);
  store.save();
  return item;
}

// Makes a pending fact live: the outdated fact it replaces is removed first.
function approvePendingFact(guildId, id) {
  const guild = store.guild(guildId);
  const index = (guild.pendingFacts ?? []).findIndex((item) => item.id === id);
  if (index === -1) return null;

  const [item] = guild.pendingFacts.splice(index, 1);
  if (item.replaces !== null) removeFact(item.userId, item.replaces);
  if (item.text) addFact(item.userId, item.text);
  store.save();
  return item;
}

function rejectPendingFact(guildId, id) {
  const list = store.guild(guildId).pendingFacts ?? [];
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return false;

  list.splice(index, 1);
  store.save();
  return true;
}

// Server-wide instructions set by administrators. Kept apart from user facts so they are never
// dropped by the per-user limit, and always sent to the AI in that server.
function getInstructions(guildId) {
  return store.guild(guildId).instructions ?? [];
}

function addInstruction(guildId, text) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;

  const guild = store.guild(guildId);
  guild.instructions ??= [];
  guild.nextInstructionId ??= 1;
  if (guild.instructions.some((item) => item.text.toLowerCase() === clean.toLowerCase())) return null;
  if (guild.instructions.length >= MAX_INSTRUCTIONS) return 'full';

  const item = { id: guild.nextInstructionId++, text: clean, createdAt: Date.now() };
  guild.instructions.push(item);
  store.save();
  return item;
}

function removeInstruction(guildId, id) {
  const list = store.guild(guildId).instructions ?? [];
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return false;

  list.splice(index, 1);
  store.save();
  return true;
}

module.exports = {
  getFacts,
  addFact,
  learnFact,
  removeFact,
  clearFacts,
  getInstructions,
  addInstruction,
  removeInstruction,
  getPending,
  addPendingFact,
  approvePendingFact,
  rejectPendingFact,
  MAX_INSTRUCTIONS,
  MAX_PENDING,
};
