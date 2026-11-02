const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./storage');
const { makeEmbed, sendLog } = require('./utils');

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_MS = 60_000;
const MAX_MS = 30 * UNITS.d;
const CHECK_EVERY_MS = 15_000;

// Accepts "90s", "10m", "2h", "1d" and combinations such as "1h 30m". Returns null when invalid.
function parseDuration(text) {
  if (!/^(\d+\s*[smhd]\s*)+$/i.test(text.trim())) return null;
  const ms = [...text.matchAll(/(\d+)\s*([smhd])/gi)].reduce(
    (sum, [, amount, unit]) => sum + Number(amount) * UNITS[unit.toLowerCase()],
    0,
  );
  return ms >= MIN_MS && ms <= MAX_MS ? ms : null;
}

// Giveaways live on the guild record in store.json, so they survive restarts.
function giveawayConfig(guildId) {
  const guild = store.guild(guildId);
  guild.giveaways ??= {};
  guild.nextGiveawayId ??= 1;
  return guild;
}

const findGiveaway = (guildId, id) => giveawayConfig(guildId).giveaways[id] ?? null;

function render(g, ended) {
  const button = new ButtonBuilder()
    .setCustomId(`giveaway:join:${g.id}`)
    .setLabel(ended ? 'Ended' : 'Enter')
    .setEmoji('🎉')
    .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(ended);

  const lines = [`**Prize:** ${g.prize}`, `**Winners:** ${g.winners}`, `**Hosted by:** <@${g.hostId}>`];
  let embed;
  if (ended) {
    const winners = g.winnerIds.length ? g.winnerIds.map((id) => `<@${id}>`).join(', ') : 'No valid entries';
    lines.push(`**Winner${g.winnerIds.length === 1 ? '' : 's'}:** ${winners}`);
    embed = makeEmbed('warn', `🎉 Giveaway ended`, lines.join('\n'));
  } else {
    lines.unshift('Click 🎉 to enter!');
    lines.push(`**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>`);
    embed = makeEmbed('info', '🎉 Giveaway', lines.join('\n'));
  }
  embed.setFooter({ text: `Giveaway #${g.id} • ${g.entries.length} entries` });
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

async function startGiveaway(channel, { prize, durationMs, winners, hostId }) {
  const cfg = giveawayConfig(channel.guild.id);
  const id = cfg.nextGiveawayId;
  cfg.nextGiveawayId += 1;

  const g = {
    id,
    channelId: channel.id,
    messageId: null,
    prize,
    winners,
    hostId,
    endsAt: Date.now() + durationMs,
    entries: [],
    winnerIds: [],
    ended: false,
  };
  const message = await channel.send(render(g, false));
  g.messageId = message.id;
  cfg.giveaways[id] = g;
  store.save();
  return g;
}

// Random pick of up to `count` distinct users.
function pickWinners(entries, count) {
  const pool = [...entries];
  const picked = [];
  while (pool.length && picked.length < count) {
    const [id] = pool.splice(Math.floor(Math.random() * pool.length), 1);
    picked.push(id);
  }
  return picked;
}

async function joinGiveaway(interaction) {
  const id = Number(interaction.customId.split(':')[2]);
  const g = findGiveaway(interaction.guild.id, id);
  if (!g || g.ended) {
    return interaction.reply({ content: 'This giveaway has ended.', flags: MessageFlags.Ephemeral });
  }

  const userId = interaction.user.id;
  const joined = !g.entries.includes(userId);
  g.entries = joined ? [...g.entries, userId] : g.entries.filter((u) => u !== userId);
  store.save();

  await interaction.update(render(g, false));
  return interaction.followUp({
    content: joined ? `You are in! Good luck. (${g.entries.length} entries)` : 'You left the giveaway.',
    flags: MessageFlags.Ephemeral,
  });
}

// Marks the giveaway as ended before any await, so the scheduler can never end it twice.
async function endGiveaway(guild, g) {
  if (g.ended) return;
  g.ended = true;
  g.winnerIds = pickWinners(g.entries, g.winners);
  store.save();

  const channel = await guild.channels.fetch(g.channelId).catch(() => null);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(g.messageId).catch(() => null)
    : null;
  if (message) await message.edit(render(g, true)).catch(() => {});

  if (channel?.isTextBased()) {
    const content = g.winnerIds.length
      ? `🎉 Congratulations ${g.winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${g.prize}**.`
      : `No valid entries for **${g.prize}**, so there is no winner.`;
    const payload = { content, allowedMentions: { users: g.winnerIds } };
    await (message ? message.reply(payload) : channel.send(payload)).catch(() => {});
  }

  await sendLog(guild, {
    embeds: [
      makeEmbed(
        'info',
        'Giveaway ended',
        `**Giveaway #${g.id}:** ${g.prize}\n**Entries:** ${g.entries.length}\n**Winners:** ${
          g.winnerIds.map((id) => `<@${id}>`).join(', ') || 'None'
        }`,
      ),
    ],
  });
}

// Picks a new set of winners, avoiding the current ones when there are enough other entries.
async function rerollGiveaway(guild, g) {
  const others = g.entries.filter((id) => !g.winnerIds.includes(id));
  g.winnerIds = pickWinners(others.length >= g.winners ? others : g.entries, g.winners);
  store.save();

  const channel = await guild.channels.fetch(g.channelId).catch(() => null);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(g.messageId).catch(() => null)
    : null;
  if (message) await message.edit(render(g, true)).catch(() => {});

  if (channel?.isTextBased()) {
    const content = g.winnerIds.length
      ? `🔁 New winner${g.winnerIds.length === 1 ? '' : 's'} for **${g.prize}**: ${g.winnerIds.map((id) => `<@${id}>`).join(', ')}`
      : `No valid entries for **${g.prize}**.`;
    await channel.send({ content, allowedMentions: { users: g.winnerIds } }).catch(() => {});
  }
  return g.winnerIds;
}

// Ends every giveaway whose time is up, including ones that expired while the bot was offline.
function startScheduler(client) {
  const check = async () => {
    for (const guild of client.guilds.cache.values()) {
      const giveaways = store.data.guilds[guild.id]?.giveaways ?? {};
      for (const g of Object.values(giveaways)) {
        if (g.ended || g.endsAt > Date.now()) continue;
        await endGiveaway(guild, g).catch((err) => console.error('Giveaway end failed:', err.message));
      }
    }
  };
  check();
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = {
  parseDuration,
  findGiveaway,
  giveawayConfig,
  startGiveaway,
  joinGiveaway,
  endGiveaway,
  rerollGiveaway,
  startScheduler,
};
