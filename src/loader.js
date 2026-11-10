const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

const SRC_DIR = __dirname;
const COMMAND_DIR = path.join(SRC_DIR, 'commands');

// Only these files are reloaded by /botreload. Stateful modules (config, storage, memory, ai, budget)
// are never reloaded: a second copy would hold its own in-memory data and drift from the first one.
const RELOADABLE_FILES = new Set(['components.js', 'tickets.js', 'utils.js', 'help.js'].map((f) => path.join(SRC_DIR, f)));

const isReloadable = (file) => file.startsWith(COMMAND_DIR + path.sep) || RELOADABLE_FILES.has(file);

// Every file in src/commands exports a `data` builder and an `execute` function.
// Some files export several commands under named keys, so both shapes are loaded.
function readCommands() {
  const commands = new Collection();
  for (const file of fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith('.js'))) {
    const mod = require(path.join(COMMAND_DIR, file));
    const entries = mod.data ? [mod] : Object.values(mod).filter((value) => value && value.data);
    for (const command of entries) commands.set(command.data.name, command);
  }
  return commands;
}

let commands = new Collection();
let components = null;

function init() {
  commands = readCommands();
  components = require('./components');
}

const findCommand = (name) => commands.get(name);
const commandCount = () => commands.size;
const allCommands = () => [...commands.values()];
const handleComponent = (interaction) => components.handleComponent(interaction);

// Remember the registration scope so a reload never registers a second copy of the commands
// (guild commands and global commands coexist in the application, which shows duplicates).
let registeredGuildId = null;

async function registerCommands(client, guildId) {
  registeredGuildId = guildId || null;
  const payload = commands.map((command) => command.data.toJSON());
  if (registeredGuildId) {
    const guild = client.guilds.cache.get(registeredGuildId) || await client.guilds.fetch(registeredGuildId);
    await guild.commands.set(payload);
    // This bot is single-guild: commands were historically registered both as guild commands and
    // as global commands (by older reloads), which shows duplicates in Discord. Clear the global
    // list so only the guild-scoped copy exists.
    try {
      await client.application.commands.set([]);
    } catch {
      // Global commands may not exist or the bot may not have rights to clear them; the guild
      // list above is the source of truth.
    }
  } else {
    await client.application.commands.set(payload);
  }
  return payload.length;
}
// Reloads command files and their helpers from disk, then re-registers the slash commands.
// If anything fails to load, the previous commands stay active and the error is thrown.
async function reload(client) {
  const previous = { commands, components };
  for (const key of Object.keys(require.cache)) {
    if (isReloadable(key)) delete require.cache[key];
  }

  try {
    const nextCommands = readCommands();
    const nextComponents = require('./components');
    commands = nextCommands;
    components = nextComponents;
  } catch (err) {
    commands = previous.commands;
    components = previous.components;
    throw err;
  }
  return registerCommands(client);
}

module.exports = { init, findCommand, allCommands, commandCount, handleComponent, registerCommands, reload };
