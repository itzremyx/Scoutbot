const { MessageFlags, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { isBotOwner, makeEmbed } = require('./utils');

// Each category lists the commands it shows. Anything not listed here appears under "Other", so new commands are never hidden.
const CATEGORIES = {
  moderation: {
    label: 'Moderation',
    emoji: '🛡️',
    description: 'Kick, ban, timeouts, warnings, auto-mod',
    commands: ['kick', 'ban', 'unban', 'timeout', 'untimeout', 'warn', 'unwarn', 'warnings', 'automod'],
  },
  channels: {
    label: 'Channels',
    emoji: '💬',
    description: 'Purge, slowmode, lock',
    commands: ['purge', 'slowmode', 'lock', 'unlock'],
  },
  levels: {
    label: 'Levels',
    emoji: '📈',
    description: 'XP, rank cards, leaderboard',
    commands: ['rank', 'leaderboard', 'xp', 'levels'],
  },
  giveaways: {
    label: 'Giveaways',
    emoji: '🎉',
    description: 'Start and manage giveaways',
    commands: ['giveaway'],
  },
  backups: {
    label: 'Backups',
    emoji: '💾',
    description: 'Save and restore roles and channels',
    commands: ['backup'],
  },
  logs: {
    label: 'Logs',
    emoji: '📜',
    description: 'Activity logs and setup',
    commands: ['logs', 'setup'],
  },
  ai: {
    label: 'AI',
    emoji: '🤖',
    description: 'Ask the bot, draw images, memory and personality',
    commands: ['ask', 'imagine', 'memory', 'personality'],
  },
  utility: {
    label: 'Utility',
    emoji: '🧰',
    description: 'Server and user info',
    commands: ['help', 'ping', 'avatar', 'userinfo', 'serverinfo'],
  },
  owner: {
    label: 'Bot owner',
    emoji: '👑',
    description: 'Bot statistics and reload',
    commands: ['botstats', 'botreload'],
    ownerOnly: true,
  },
};

const OTHER = { label: 'Other', emoji: '📦', description: 'Commands without a category', commands: [] };

// Builds the category list for a command set. Owner-only categories are dropped for everyone else.
function visibleCategories(commands, isOwner) {
  const byName = new Map(commands.map((c) => [c.data.name, c]));
  const listed = new Set();
  const result = [];

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.ownerOnly && !isOwner) continue;
    const items = cat.commands.map((name) => byName.get(name)).filter(Boolean);
    for (const name of cat.commands) listed.add(name);
    if (items.length) result.push({ key, ...cat, items });
  }

  const rest = commands.filter((c) => !listed.has(c.data.name) && !c.ownerOnly);
  if (rest.length) result.push({ key: 'other', ...OTHER, items: rest });
  return result;
}

function formatCommand(command) {
  const json = command.data.toJSON();
  const subs = (json.options ?? []).filter((o) => o.type === 1);
  if (!subs.length) return `\`/${json.name}\`: ${json.description}`;
  return subs.map((s) => `\`/${json.name} ${s.name}\`: ${s.description}`).join('\n');
}

function categoryEmbed(category) {
  const lines = category.items.map(formatCommand).join('\n');
  return makeEmbed('info', `${category.emoji} ${category.label}`, lines);
}

function helpPayload(commands, isOwner) {
  const categories = visibleCategories(commands, isOwner);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help:select')
    .setPlaceholder('Choose a category')
    .addOptions(
      categories.map((c) =>
        new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.key).setDescription(c.description).setEmoji(c.emoji),
      ),
    );

  const overview = makeEmbed(
    'info',
    'Help',
    'Pick a category in the menu to see its commands.\n\n' +
      categories.map((c) => `${c.emoji} **${c.label}**: ${c.description}`).join('\n'),
  );
  return { embeds: [overview], components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral };
}

// Called when someone picks a category. Edits the same message so the menu stays usable.
async function handleHelpSelect(interaction, commands) {
  const isOwner = await isBotOwner(interaction.client, interaction.user.id);
  const key = interaction.values[0];
  const category = visibleCategories(commands, isOwner).find((c) => c.key === key);
  if (!category) {
    return interaction.update({ embeds: [makeEmbed('error', 'Help', 'That category is not available.')], components: [] });
  }
  const { components } = helpPayload(commands, isOwner);
  return interaction.update({ embeds: [categoryEmbed(category)], components });
}

module.exports = { helpPayload, handleHelpSelect, visibleCategories };
