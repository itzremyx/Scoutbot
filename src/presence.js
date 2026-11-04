const store = require('./storage');

const MODES = ['online', 'idle', 'dnd', 'invisible'];

function configured() {
  const value = store.data.settings.presence;
  return MODES.includes(value) ? value : 'dnd';
}

async function apply(client, status = configured()) {
  const next = MODES.includes(status) ? status : 'dnd';
  await client.user.setPresence({ status: next });
  store.data.settings.presence = next;
  store.save();
  return next;
}

module.exports = { MODES, configured, apply };
