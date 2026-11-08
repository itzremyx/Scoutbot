const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const budget = require('../budget');
const ai = require('../ai');
const loader = require('../loader');
const store = require('../storage');
const { formatDuration, makeEmbed } = require('../utils');

const LOG_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
];

async function checkChannel(client, id) {
  if (!id) return { ok: false, value: 'not configured' };
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel) return { ok: false, value: `dead id ${id}` };
  const perms = channel.permissionsFor?.(client.user);
  const missing = [];
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View');
  if (!perms?.has(PermissionFlagsBits.SendMessages)) missing.push('Send');
  return { ok: missing.length === 0, value: `${channel}${missing.length ? ` (missing ${missing.join(', ')})` : ''}` };
}

async function checkLogChannel(client, guild, id) {
  if (!id) return { ok: false, value: 'not configured' };
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (!channel) return { ok: false, value: `dead id ${id}` };
  const perms = channel.permissionsFor?.(client.user);
  const missing = LOG_PERMISSIONS.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
  return { ok: missing.length === 0, value: `${channel}${missing.length ? ` (missing ${missing.join(', ')})` : ''}` };
}

module.exports = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('doctor')
    .setDescription('Check channels, permissions, AI and stored data (bot owner only)'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = interaction.client;
    const problems = [];
    const env = [];
    const channels = [];
    const data = [];

    const line = (list, ok, text, problem) => {
      list.push(`${ok ? '✅' : '❌'} ${text}`);
      if (!ok && problem) problems.push(problem);
    };

    // Environment
    line(env, Boolean(config.token), `Discord token: ${config.token ? 'set' : 'missing'}`, 'DISCORD_TOKEN is missing');
    line(env, Boolean(config.ai.apiKey), `AI key: ${config.ai.apiKey ? 'set' : 'missing'}`, 'AI_API_KEY is missing');
    line(env, /^https:\/\//i.test(config.ai.baseUrl), `AI base URL: ${config.ai.baseUrl}`, 'AI_BASE_URL is not HTTPS');
    line(env, Boolean(config.owner.id), `Owner ID: ${config.owner.id || 'missing'}`, 'BOT_OWNER_ID is missing');

    // Channel ids resolve and the bot can post in them
    const channelTargets = [
      ['AI channel', config.aiChannelId],
      ['Commit changelog', config.botRepoChannelId],
      ['ScoutCode updates', config.updateChannelId],
      ['ScoutCode changelog', config.changelogChannelId],
    ];
    for (const [label, id] of channelTargets) {
      const result = await checkChannel(client, id);
      line(channels, result.ok, `${label}: ${result.value}`, `${label} is unusable (${result.value})`);
    }

    for (const [guildId, guildData] of Object.entries(store.data.guilds ?? {})) {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        line(channels, false, `Log channel: guild ${guildId} is not reachable`, `Guild ${guildId} is not reachable`);
        continue;
      }
      const result = await checkLogChannel(client, guild, guildData.logChannelId);
      line(channels, result.ok, `Log channel (${guild.name}): ${result.value}`, `Log channel for ${guild.name} is unusable (${result.value})`);
    }

    // Stored data
    const guildCount = Object.keys(store.data.guilds ?? {}).length;
    const userCount = Object.keys(store.data.users ?? {}).length;
    const ticketCount = Object.values(store.data.guilds ?? {})
      .reduce((total, guild) => total + Object.keys(guild.tickets ?? {}).length, 0);
    data.push(`✅ Store: ${guildCount} guild(s), ${userCount} user(s), ${ticketCount} open ticket(s)`);

    const botRepo = store.data.settings?.botRepo;
    if (botRepo?.lastSha) {
      const pending = Math.max(0, (botRepo.announced ?? 0) - (botRepo.delivered ?? 0));
      data.push(`${pending ? '⚠️' : '✅'} Commit cursor: ${botRepo.lastSha.slice(0, 7)} (${pending} undelivered)`);
      if (pending) problems.push(`${pending} commit(s) announced but not delivered to the changelog channel`);
    } else {
      data.push('❌ Commit cursor: not initialised');
      problems.push('The commit changelog cursor is not initialised');
    }

    const status = budget.status();
    const memory = process.memoryUsage();
    const runtime = [
      `✅ WebSocket: ${client.ws.ping}ms`,
      `✅ Uptime: ${formatDuration(process.uptime() * 1000)}`,
      `✅ Memory: ${(memory.rss / 1024 / 1024).toFixed(1)} MB`,
      `✅ AI model: ${ai.activeModel()}`,
      `✅ Commands loaded: ${loader.commandCount()}`,
      `✅ AI today: ${status.callsToday} call(s), ${status.tokensToday.toLocaleString('en-US')} token(s)`,
    ];

    const ok = problems.length === 0;
    const embed = makeEmbed(
      ok ? 'success' : 'warn',
      ok ? 'All checks passed' : 'Issues found',
      ok ? 'ScoutBot looks healthy.' : problems.map((problem) => `• ${problem}`).join('\n').slice(0, 2000),
    ).addFields(
      { name: 'Environment', value: env.join('\n').slice(0, 1024) },
      { name: 'Channels', value: channels.join('\n').slice(0, 1024) },
      { name: 'Data', value: data.join('\n').slice(0, 1024) },
      { name: 'Runtime', value: runtime.join('\n').slice(0, 1024) },
    );
    return interaction.editReply({ embeds: [embed] });
  },
};
