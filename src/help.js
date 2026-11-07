const {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { isBotOwner, makeEmbed } = require('./utils');

const CATEGORIES = {
  moderation: { label: 'Moderation', emoji: String.fromCodePoint(0x1F6E1), description: 'Kick, ban, timeouts, warnings and moderation history', commands: ['kick', 'ban', 'unban', 'timeout', 'untimeout', 'warn', 'unwarn', 'warnings', 'automod', 'modlog'] },
  channels: { label: 'Channels', emoji: String.fromCodePoint(0x1F4AC), description: 'Purge, slowmode, locks, sticky messages and polls', commands: ['purge', 'purge-user-time', 'slowmode', 'lock', 'unlock', 'sticky', 'poll'] },
  levels: { label: 'Levels', emoji: String.fromCodePoint(0x1F4C8), description: 'XP, rank cards and leaderboard', commands: ['rank', 'leaderboard', 'xp', 'levels'] },
  giveaways: { label: 'Giveaways', emoji: String.fromCodePoint(0x1F389), description: 'Start and manage giveaways', commands: ['giveaway'] },
  backups: { label: 'Backups', emoji: String.fromCodePoint(0x1F4BE), description: 'Save and restore roles and channels', commands: ['backup'] },
  logs: { label: 'Logs', emoji: String.fromCodePoint(0x1F4DC), description: 'Activity logs and setup', commands: ['logs', 'setup'] },
  ai: { label: 'AI', emoji: String.fromCodePoint(0x1F916), description: 'Ask questions, draw images, memory and personality', commands: ['ask', 'imagine', 'image-quota', 'prompt-history', 'memory', 'personality'] },
  invites: { label: 'Invites', emoji: String.fromCodePoint(0x1F465), description: 'Invite counts and leaderboard', commands: ['invites'] },
  utility: { label: 'Utility', emoji: String.fromCodePoint(0x1F9F0), description: 'Server and user information, health and reminders', commands: ['help', 'health', 'ping', 'avatar', 'userinfo', 'serverinfo', 'remind', 'changelog', 'download', 'link'] },
  radio: { label: 'Radio', emoji: String.fromCodePoint(0x1F3B5), description: 'Play music in a voice channel and show the current track', commands: ['radio'] },
  owner: { label: 'Bot owner', emoji: String.fromCodePoint(0x1F451), description: 'Bot statistics, diagnostics, presence, repository checks and reload', commands: ['botstats', 'botreload', 'debug', 'presence', 'repo-refresh', 'role'], ownerOnly: true },
};

const OTHER = { label: 'Other', emoji: String.fromCodePoint(0x1F4E6), description: 'Commands without a category', commands: [] };

// Discord locales are reduced to the languages supported by this help view.
const LOCALES = {
  en: { choose: 'Choose a category', translate: 'Translate to English', title: 'Help', intro: 'Pick a category in the menu to see its commands.', unavailable: 'That category is not available.', categories: {} },
  fr: {
    choose: 'Choisissez une categorie', translate: 'Traduire en anglais', title: 'Aide',
    intro: 'Choisissez une categorie dans le menu pour voir ses commandes.', unavailable: 'Cette categorie n est pas disponible.',
    categories: {
      moderation: ['Moderation', 'Expulser, bannir, avertir et gerer la moderation'], channels: ['Salons', 'Gerer les salons, messages epingles et sondages'],
      levels: ['Niveaux', 'XP, cartes de rang et classement'], giveaways: ['Concours', 'Creer et gerer des concours'], backups: ['Sauvegardes', 'Sauvegarder et restaurer les salons et roles'],
      logs: ['Journaux', 'Journaux d activite et configuration'], ai: ['IA', 'Questions, images, memoire et personnalite'], utility: ['Utilitaires', 'Informations, sante du bot et rappels'],
      owner: ['Proprietaire du bot', 'Statistiques, diagnostics, presence, depot et rechargement'], other: ['Autres', 'Commandes sans categorie'],
    },
  },
  de: { choose: 'Kategorie auswahlen', translate: 'Auf Englisch ubersetzen', title: 'Hilfe', intro: 'Wahle eine Kategorie, um ihre Befehle zu sehen.', unavailable: 'Diese Kategorie ist nicht verfugbar.', categories: { ai: ['KI', 'Fragen, Bilder, Speicher und Personlichkeit'], utility: ['Werkzeuge', 'Informationen, Bot-Status und Erinnerungen'] } },
  es: { choose: 'Elige una categoria', translate: 'Al ingles', title: 'Ayuda', intro: 'Elige una categoria para ver sus comandos.', unavailable: 'Esta categoria no esta disponible.', categories: { ai: ['IA', 'Preguntas, imagenes, memoria y personalidad'], utility: ['Utilidades', 'Informacion, estado del bot y recordatorios'] } },
  pt: { choose: 'Escolha uma categoria', translate: 'Traduzir para ingles', title: 'Ajuda', intro: 'Escolha uma categoria para ver seus comandos.', unavailable: 'Essa categoria nao esta disponivel.', categories: { ai: ['IA', 'Perguntas, imagens, memoria e personalidade'], utility: ['Utilidades', 'Informacoes, estado do bot e lembretes'] } },
  ja: { choose: 'Select a category', translate: 'Translate to English', title: 'Help', intro: 'Select a category to see its commands.', unavailable: 'That category is not available.', categories: { ai: ['AI', 'Questions, images, memory and personality'], utility: ['Utility', 'Information, bot status and reminders'] } },
};

function localeKey(locale) {
  const key = String(locale ?? '').toLowerCase().split(/[-_]/)[0];
  return LOCALES[key] ? key : 'en';
}

function localize(category, locale) {
  const value = LOCALES[locale].categories[category.key];
  return value ? { ...category, label: value[0], description: value[1] } : category;
}

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

function categoryEmbed(category, locale = 'en') {
  const localized = localize(category, locale);
  return makeEmbed('info', `${localized.emoji} ${localized.label}`, localized.items.map(formatCommand).join('\n'));
}

function helpPayload(commands, isOwner, requestedLocale = 'en') {
  const locale = localeKey(requestedLocale);
  const strings = LOCALES[locale];
  const categories = visibleCategories(commands, isOwner).map((category) => localize(category, locale));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`help:select:${locale}`)
    .setPlaceholder(strings.choose)
    .addOptions(categories.map((category) => new StringSelectMenuOptionBuilder()
      .setLabel(category.label).setValue(category.key).setDescription(category.description).setEmoji(category.emoji)));
  const overview = makeEmbed('info', strings.title, `${strings.intro}\n\n${categories.map((c) => `${c.emoji} **${c.label}**: ${c.description}`).join('\n')}`);
  const translate = new ButtonBuilder().setCustomId('help:english').setLabel(strings.translate).setStyle(ButtonStyle.Secondary);
  return {
    embeds: [overview],
    components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(translate)],
    flags: MessageFlags.Ephemeral,
  };
}

async function handleHelpSelect(interaction, commands) {
  const isOwner = await isBotOwner(interaction.client, interaction.user.id);
  const locale = localeKey(interaction.customId.split(':')[2] || interaction.locale);
  const category = visibleCategories(commands, isOwner).find((item) => item.key === interaction.values[0]);
  if (!category) return interaction.update({ embeds: [makeEmbed('error', LOCALES[locale].title, LOCALES[locale].unavailable)], components: [] });
  return interaction.update({ embeds: [categoryEmbed(category, locale)], components: helpPayload(commands, isOwner, locale).components });
}

async function handleHelpEnglish(interaction, commands) {
  const isOwner = await isBotOwner(interaction.client, interaction.user.id);
  const { embeds, components } = helpPayload(commands, isOwner, 'en');
  return interaction.update({ embeds, components });
}

module.exports = { helpPayload, handleHelpSelect, handleHelpEnglish, visibleCategories };
