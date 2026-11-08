const { Events } = require('discord.js');
const { post } = require('./logs');

// Alt-account detection only reports: nothing is done to the member. A young account or a member
// with the default avatar is worth a look, but it is not proof on its own.
const YOUNG_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

const ageLabel = (ms) => {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)} hour(s)`;
  return `${Math.floor(hours / 24)} day(s)`;
};

function register(client) {
  client.on(Events.GuildMemberAdd, (member) => {
    if (member.user?.bot) return;
    const age = Date.now() - member.user.createdTimestamp;
    const young = age < YOUNG_ACCOUNT_MS;
    const noAvatar = !member.user.avatar;
    if (!young && !noAvatar) return;

    const reasons = [];
    if (young) reasons.push(`account is only ${ageLabel(age)} old`);
    if (noAvatar) reasons.push('no custom avatar');

    post(member.guild, 'warn', 'Possible alt account', [
      ['Member', `${member.user} (${member.user.tag})`, true],
      ['Created', `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, true],
      ['Reason', reasons.join(', ')],
      ['Action', 'Logged only, no action taken'],
    ]).catch((err) => console.error('Alt log failed:', err.message));
  });
}

module.exports = { register, YOUNG_ACCOUNT_MS };
