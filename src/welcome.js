const { AttachmentBuilder } = require('discord.js');
const store = require('./storage');
const { renderWelcomeCard } = require('./welcomecard');

// Welcome and farewell live on the guild record so /setup changes survive restarts.
// theme: null means "use the levels theme", so the cards stay in the same visual language.
function welcomeConfig(guildId) {
  const guild = store.guild(guildId);
  guild.welcome ??= { enabled: true, leaveEnabled: false, channelId: null, theme: null, inviteCount: 0 };
  return guild.welcome;
}

function channelFor(guild, cfg) {
  if (cfg.channelId) return guild.channels.cache.get(cfg.channelId) ?? null;
  const systemId = guild.systemChannelId;
  return systemId ? guild.channels.cache.get(systemId) ?? null : null;
}

// The welcome card is rendered with the levels theme, matching the level-up announcements.
async function welcomeMember(guild, member) {
  const cfg = welcomeConfig(guild.id);
  if (!cfg.enabled) return;
  const channel = channelFor(guild, cfg);
  if (!channel?.isTextBased()) return;
  const levelsTheme = store.guild(guild.id).levels?.theme;
  const png = await renderWelcomeCard({
    username: member.user.globalName ?? member.user.username,
    avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
    themeId: cfg.theme ?? levelsTheme ?? 'claude',
    memberCount: guild.memberCount,
    joinDate: member.joinedTimestamp ?? member.user.createdTimestamp,
  }).catch(() => null);
  const files = png ? [new AttachmentBuilder(png, { name: 'welcome.png' })] : [];
  const count = guild.memberCount > 1 ? ' — you are member #' + guild.memberCount + '.' : '.';
  await channel
    .send({
      files,
      content: 'Welcome <@' + member.id + '> to ' + guild.name + count,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

// Farewell is plain text: the member is gone, so no card.
async function farewellMember(guild, user) {
  const cfg = welcomeConfig(guild.id);
  if (!cfg.leaveEnabled) return;
  const channel = channelFor(guild, cfg);
  if (!channel?.isTextBased()) return;
  await channel
    .send({
      content: (user.globalName ?? user.username ?? 'A member') + ' left ' + guild.name + '.',
    })
    .catch(() => {});
}

function register(client) {
  client.on('guildMemberAdd', (member) => welcomeMember(member.guild, member).catch(() => {}));
  client.on('guildMemberRemove', (member) => {
    if (member && member.user) farewellMember(member.guild, member.user).catch(() => {});
  });
}

module.exports = { welcomeConfig, register, welcomeMember, farewellMember };
