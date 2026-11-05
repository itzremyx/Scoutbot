const { Events } = require('discord.js');
const config = require('./config');
const store = require('./storage');

// Auto-role: every member who joins is given the configured role. The runtime value is
// kept in store.data.settings.autoRoleId (set by /role all), falling back to the
// AUTO_ROLE_ID env value in config. The GuildMemberAdd log handler in logs.js also
// runs; this simply adds the role on top of it.
function roleId() {
  const fromStore = store.data.settings?.autoRoleId;
  if (fromStore && fromStore !== '0') return String(fromStore);
  return config.autoRoleId;
}

async function onMemberAdd(member) {
  const id = roleId();
  if (!id || id === '0') return;
  try {
    const role = member.guild?.roles?.cache.get(id);
    if (!role) return; // role deleted or this guild has no such role
    if (member.roles?.cache.has(id)) return; // already has it
    await member.roles.add(id);
    console.log(`Auto-role: gave ${member.user.tag} ${role.name} in ${member.guild.name}`);
  } catch (err) {
    // The join welcome may run during server setup; never crash the listener.
    console.error('Auto-role failed:', err.message);
  }
}

function register(client) {
  client.on(Events.GuildMemberAdd, (member) => onMemberAdd(member).catch((err) => console.error('Auto-role error:', err.message)));
}

module.exports = { register, roleId };
