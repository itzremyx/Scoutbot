const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('./storage');
const { renderWelcomeCard, renderFarewellCard } = require('./welcomecard');

// code -> { uses, inviterId }. Compared before and after a join to find who invited the member.
const inviteCache = new Map();

function record(guildId, invite) {
  const map = inviteCache.get(guildId) ?? new Map();
  map.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviterId ?? invite.inviter?.id ?? null });
  inviteCache.set(guildId, map);
}

async function refreshInvites(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  inviteCache.set(guild.id, new Map());
  for (const invite of invites.values()) record(guild.id, invite);
}

// The invite whose use count went up is the one this member joined with.
async function invitedBy(member) {
  const guild = member.guild;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const before = inviteCache.get(guild.id) ?? new Map();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;

  let used = null;
  for (const invite of invites.values()) {
    const previous = before.get(invite.code);
    if (previous && invite.uses > previous.uses) used = invite;
    record(guild.id, invite);
  }
  for (const code of before.keys()) {
    if (!invites.has(code)) inviteCache.get(guild.id)?.delete(code);
  }
  if (!used?.inviter) return null;

  const stats = store.guild(guild.id);
  stats.invites ??= {};
  const entry = (stats.invites[used.inviter.id] ??= { regular: 0, leaves: 0 });
  entry.regular += 1;
  stats.invited ??= {};
  stats.invited[member.id] = used.inviter.id;
  store.save();
  return { tag: used.inviter.username, count: entry.regular };
}

// Welcome and farewell live on the guild record so /setup changes survive restarts.
// theme: null means "use the levels theme", so the cards stay in the same visual language.
function welcomeConfig(guildId) {
  const guild = store.guild(guildId);
  guild.welcome ??= { enabled: true, leaveEnabled: false, channelId: null, theme: null };
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
  const inviter = await invitedBy(member).catch(() => null);
  const png = await renderWelcomeCard({
    username: member.user.globalName ?? member.user.username,
    avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
    themeId: cfg.theme ?? levelsTheme ?? 'claude',
    memberCount: guild.memberCount,
    joinDate: member.joinedTimestamp ?? member.user.createdTimestamp,
    invitedBy: inviter,
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

// Farewell card mirrors the welcome card. memberCount is the count after the member has left.
async function farewellMember(guild, user) {
  const cfg = welcomeConfig(guild.id);
  if (!cfg.leaveEnabled) return;
  const channel = channelFor(guild, cfg);
  if (!channel?.isTextBased()) return;
  const levelsTheme = store.guild(guild.id).levels?.theme;
  const username = user.globalName ?? user.username ?? 'A member';
  const png = await renderFarewellCard({
    username,
    avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256 }),
    themeId: cfg.theme ?? levelsTheme ?? 'claude',
    memberCount: guild.memberCount,
  }).catch(() => null);
  const files = png ? [new AttachmentBuilder(png, { name: 'farewell.png' })] : [];
  await channel
    .send({
      files,
      content: username + ' left ' + guild.name + ' — ' + guild.memberCount + ' members left.',
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

function register(client) {
  const ready = () => {
    for (const guild of client.guilds.cache.values()) refreshInvites(guild).catch(() => {});
  };
  if (client.isReady()) ready();
  else client.once('clientReady', ready);
  client.on('inviteCreate', (invite) => { if (invite.guild) record(invite.guild.id, invite); });
  client.on('inviteDelete', (invite) => { if (invite.guild) inviteCache.get(invite.guild.id)?.delete(invite.code); });
  client.on('guildMemberAdd', (member) => welcomeMember(member.guild, member).catch(() => {}));
  client.on('guildMemberRemove', (member) => {
    const inviterId = store.guild(member.guild.id).invited?.[member.id];
    const entry = inviterId ? store.guild(member.guild.id).invites?.[inviterId] : null;
    if (entry) {
      entry.leaves += 1;
      store.save();
    }
    if (member?.user) farewellMember(member.guild, member.user).catch(() => {});
  });
}

module.exports = { welcomeConfig, register, welcomeMember, farewellMember };
