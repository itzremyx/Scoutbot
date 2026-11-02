const { MessageFlags, Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./src/config');
const loader = require('./src/loader');
const logs = require('./src/logs');
const giveaways = require('./src/giveaways');
const levels = require('./src/levels');
const chat = require('./src/chat');
const { fail, isBotOwner } = require('./src/utils');

if (!config.token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution,
    GatewayIntentBits.MessageContent,
  ],
  // Partials let the bot receive edits and deletes of messages sent before it started.
  partials: [Partials.Message, Partials.Channel],
});

loader.init();
logs.register(client);
levels.register(client);
chat.register(client);

function friendlyError(err) {
  if (err.code === 50013) return 'I am missing the permissions needed for this action.';
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) {
    return 'Could not reach an external service. It looks like a connection problem, try again in a moment.';
  }
  return err.message || 'Something went wrong.';
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  const count = await loader.registerCommands(c);
  console.log(`Registered ${count} slash commands. Global commands can take up to an hour to show up.`);
  giveaways.startScheduler(c);
  levels.startScheduler(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = loader.findCommand(interaction.commandName);
      if (!command) return;
      if (command.guildOnly && !interaction.guild) {
        return interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
      }
      if (command.ownerOnly && !(await isBotOwner(client, interaction.user.id))) {
        return fail(interaction, 'Only the bot owner can use this command.');
      }
      return await command.execute(interaction);
    }

    if (interaction.isStringSelectMenu() || interaction.isButton()) {
      return await loader.handleComponent(interaction);
    }
  } catch (err) {
    console.error(err);
    await fail(interaction, friendlyError(err)).catch(() => {});
  }
});

// Chat replies (mentions in servers, plain conversation in DMs) live in src/chat.js.
client.login(config.token);
