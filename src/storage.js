const fs = require('fs');
const path = require('path');
const { dataFile } = require('./config');

function read() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Everything the bot remembers lives in data/store.json:
// settings, per-guild data, per-user memories (users) and per-channel chat history (conversations).
const data = { settings: {}, guilds: {}, users: {}, conversations: {}, ...read() };

function save() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dataFile);
}

function guild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      logChannelId: null,
      ticketCategoryId: null,
      tickets: {},
      warnings: {},
      nextWarningId: 1,
      invitations: [],
      nextInstructionId: 1,
      welcome: { enabled: true, leaveEnabled: false, channelId: null, theme: null, inviteCount: 0 },
      inviteTracker: { channelId: null, inviteCount: 0 },
    };
  }
  return data.guilds[guildId];
}

module.exports = { data, save, guild };
