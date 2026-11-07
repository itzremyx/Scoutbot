const { Events } = require('discord.js');
const store = require('./storage');

const DEFAULT_DURATION_MINUTES = 30;

// Raid protection state: guild.raid = { enabled, endsAt, timeoutMinutes }.
// While active (and before endsAt), every member who joins is timed out for timeoutMinutes.
function raidConfig(guildId) {
  const guild = store.guild(guildId);
  guild.raid ??= { enabled: false, endsAt: null, timeoutMinutes: DEFAULT_DURATION_MINUTES };
  return guild.raid;
}

function isRaidActive(guildId) {
  const config = raidConfig(guildId);
  return config.enabled && config.endsAt > Date.now();
}

// Every join while the window is open is timed out (wave after wave during a raid).
function register(client) {
  client.on(Events.GuildMemberAdd, (member) => {
    if (member.bot) return;
    if (!isRaidActive(member.guild.id)) return;
    const config = raidConfig(member.guild.id);
    member
      .timeout(config.timeoutMinutes * 60_000, 'Raid protection: member joined during raid mode')
      .catch((err) => console.error('Raid timeout failed:', err.message));
  });
}

module.exports = { raidConfig, isRaidActive, register };
