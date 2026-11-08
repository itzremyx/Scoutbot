const { MessageFlags, EmbedBuilder, Team } = require('discord.js');
const store = require('./storage');

const COLORS = { info: 0x5865f2, success: 0x57f287, warn: 0xfee75c, error: 0xed4245 };

function makeEmbed(kind, title, description) {
  const embed = new EmbedBuilder().setColor(COLORS[kind]).setTitle(title).setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Splits long text into chunks that fit Discord's 2000 character message limit.
function splitText(text, max = 1900) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

// Sends an error embed, either as a reply or by editing a deferred reply.
function fail(interaction, message) {
  const embed = makeEmbed('error', 'Action failed', message);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed], components: [] });
  }
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function hasPerm(interaction, flag) {
  return interaction.memberPermissions?.has(flag) ?? false;
}

async function fetchMember(guild, userId) {
  return guild.members.fetch(userId).catch(() => null);
}

// Returns an error message if the moderator may not act on the target member, otherwise null.
async function checkTarget(guild, moderatorId, target) {
  if (target.id === moderatorId) return "You can't moderate yourself.";
  if (target.id === guild.client.user.id) return "You can't moderate me.";
  if (target.id === guild.ownerId) return "You can't moderate the server owner.";

  if (moderatorId !== guild.ownerId) {
    const moderator = await fetchMember(guild, moderatorId);
    if (moderator && target.roles.highest.position >= moderator.roles.highest.position) {
      return 'That member has a role equal to or higher than yours.';
    }
  }

  const me = await fetchMember(guild, guild.client.user.id);
  if (me && target.roles.highest.position >= me.roles.highest.position) {
    return 'My role is not high enough to moderate that member.';
  }
  return null;
}

async function sendLog(guild, payload) {
  const { logChannelId } = store.guild(guild.id);
  if (!logChannelId) return false;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  return channel.send(payload).then(() => true).catch(() => false);
}

async function dmUser(user, embed) {
  await user.send({ embeds: [embed] }).catch(() => {});
}

// True if the user owns the Discord application (or is a member of its owning team).
async function isBotOwner(client, userId) {
  if (String(userId) === String(require('./config').owner.id)) return true;
  const app = await client.application.fetch();
  const owner = app.owner;
  if (!owner) return false;
  if (owner instanceof Team) return owner.members.has(userId);
  return owner.id === userId;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, `${seconds}s`]
    .filter(Boolean)
    .join(' ');
}

module.exports = {
  makeEmbed,
  truncate,
  splitText,
  fail,
  hasPerm,
  fetchMember,
  checkTarget,
  sendLog,
  dmUser,
  isBotOwner,
  formatDuration,
};
