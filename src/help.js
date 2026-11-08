const {
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { isBotOwner, makeEmbed } = require('./utils');

const CATEGORIES = {
  moderation: { label: 'Moderation', emoji: String.fromCodePoint(0x1F6E1), description: 'Kick, ban, timeouts, warnings, nicknames, raid protection and moderation history', commands: ['kick', 'ban', 'unban', 'timeout', 'untimeout', 'warn', 'unwarn', 'warnings', 'automod', 'modlog', 'nick', 'raid'] },
  channels: { label: 'Channels', emoji: String.fromCodePoint(0x1F4AC), description: 'Purge, slowmode, locks, broadcast, sticky messages and polls', commands: ['purge', 'purge-user-time', 'slowmode', 'lock', 'unlock', 'lockdown', 'unlockdown', 'broadcast', 'sticky', 'poll'] },
  levels: { label: 'Levels', emoji: String.fromCodePoint(0x1F4C8), description: 'XP, rank cards and leaderboard', commands: ['rank', 'leaderboard', 'xp', 'levels'] },
  giveaways: { label: 'Giveaways', emoji: String.fromCodePoint(0x1F389), description: 'Start and manage giveaways', commands: ['giveaway'] },
  backups: { label: 'Backups', emoji: String.fromCodePoint(0x1F4BE), description: 'Save and restore roles and channels', commands: ['backup'] },
  logs: { label: 'Logs', emoji: String.fromCodePoint(0x1F4DC), description: 'Activity logs, setup and transcript search', commands: ['logs', 'setup', 'transcript'] },
  community: { label: 'Community', emoji: String.fromCodePoint(0x1F4A1), description: 'Saved tags, suggestions and translation', commands: ['tag', 'suggest', 'accept', 'decline', 'duplicate', 'translate'] },
  ai: { label: 'AI', emoji: String.fromCodePoint(0x1F916), description: 'Ask questions, draw images, memory and personality', commands: ['ask', 'imagine', 'image-quota', 'prompt-history', 'memory', 'personality'] },
  invites: { label: 'Invites', emoji: String.fromCodePoint(0x1F465), description: 'Invite counts and leaderboard', commands: ['invites'] },
  utility: { label: 'Utility', emoji: String.fromCodePoint(0x1F9F0), description: 'Server and user information, health, AFK and reminders', commands: ['help', 'health', 'ping', 'avatar', 'userinfo', 'serverinfo', 'afk', 'remind', 'changelog', 'download', 'link'] },
  radio: { label: 'Radio', emoji: String.fromCodePoint(0x1F3B5), description: 'Play music in a voice channel and show the current track', commands: ['radio'] },
  owner: { label: 'Bot owner', emoji: String.fromCodePoint(0x1F451), description: 'Bot statistics, diagnostics, health checks, presence, repository checks and reload', commands: ['botstats', 'botreload', 'debug', 'doctor', 'presence', 'repo-refresh', 'role'], ownerOnly: true },
};

const OTHER = { label: 'Other', emoji: String.fromCodePoint(0x1F4E6), description: 'Commands without a category', commands: [] };

// The bot is English-only, so /help always uses this single set of strings.
const STRINGS = {
  choose: 'Choose a category',
  title: 'Help',
  intro: 'Pick a category in the menu to see its commands.',
  unavailable: 'That category is not available.',
};

function visibleCategories(commands, isOwner) {
  const byName = new Map(commands.map((c) => [c.data.name, c]));
  const listed = new Set();
  const result = [];
  for (const [key, category] of Object.entries(CATEGORIES)) {
    if (category.ownerOnly && !isOwner) continue;
    const items = category.commands.map((name) => byName.get(name)).filter(Boolean);
    category.commands.forEach((name) => listed.add(name));
    if (items.length) result.push({ key, ...category, items });
  }
  const rest = commands.filter((c) => !listed.has(c.data.name) && !c.ownerOnly);
  if (rest.length) result.push({ key: 'other', ...OTHER, items: rest });
  return result;
}

function formatCommand(command) {
  const json = command.data.toJSON();
  const subs = (json.options ?? []).filter((option) => option.type === 1);
  if (!subs.length) return `\`/${json.name}\`: ${json.description}`;
  return subs.map((sub) => `\`/${json.name} ${sub.name}\`: ${sub.description}`).join('\n');
}

function categoryEmbed(category) {
  return makeEmbed('info', `${category.emoji} ${category.label}`, category.items.map(formatCommand).join('\n'));
}

// The extra parameters keep older call sites working; the help view itself is always English.
function helpPayload(commands, isOwner) {
  const categories = visibleCategories(commands, isOwner);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help:select')
    .setPlaceholder(STRINGS.choose)
    .addOptions(categories.map((category) => new StringSelectMenuOptionBuilder()
      .setLabel(category.label).setValue(category.key).setDescription(category.description).setEmoji(category.emoji)));
  const overview = makeEmbed('info', STRINGS.title, `${STRINGS.intro}\n\n${categories.map((c) => `${c.emoji} **${c.label}**: ${c.description}`).join('\n')}`);
  return {
    embeds: [overview],
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  };
}

async function handleHelpSelect(interaction, commands) {
  const isOwner = await isBotOwner(interaction.client, interaction.user.id);
  const category = visibleCategories(commands, isOwner).find((item) => item.key === interaction.values[0]);
  if (!category) return interaction.update({ embeds: [makeEmbed('error', STRINGS.title, STRINGS.unavailable)], components: [] });
  return interaction.update({ embeds: [categoryEmbed(category)], components: helpPayload(commands, isOwner).components });
}

// Kept so the "Translate to English" button on help messages posted by older builds still
// works: it simply re-renders the English help view.
async function handleHelpEnglish(interaction, commands) {
  const isOwner = await isBotOwner(interaction.client, interaction.user.id);
  const { embeds, components } = helpPayload(commands, isOwner);
  return interaction.update({ embeds, components });
}

module.exports = { helpPayload, handleHelpSelect, handleHelpEnglish, visibleCategories };
