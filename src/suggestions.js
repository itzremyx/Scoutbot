const store = require('./storage');

// Suggestions are stored per guild, keyed by the forum thread id, so the staff commands can look
// up the post they were run in. Entry: { authorId, title, tag, status, createdAt, decidedBy, decidedAt }
function suggestionStore(guildId) {
  const guild = store.guild(guildId);
  guild.suggestions ??= {};
  return guild.suggestions;
}

function addSuggestion(guildId, threadId, data) {
  const all = suggestionStore(guildId);
  all[threadId] = { status: 'open', createdAt: Date.now(), decidedBy: null, decidedAt: null, ...data };
  store.save();
  return all[threadId];
}

function getSuggestion(guildId, threadId) {
  return suggestionStore(guildId)[threadId] ?? null;
}

function setSuggestionStatus(guildId, threadId, status, staffId, note = null) {
  const suggestion = getSuggestion(guildId, threadId);
  if (!suggestion) return null;
  suggestion.status = status;
  suggestion.decidedBy = staffId;
  suggestion.decidedAt = Date.now();
  if (note) suggestion.note = note;
  store.save();
  return suggestion;
}

module.exports = { suggestionStore, addSuggestion, getSuggestion, setSuggestionStatus };
