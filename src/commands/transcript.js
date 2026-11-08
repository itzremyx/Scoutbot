const fs = require('fs');
const path = require('path');
const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

const STAFF = PermissionFlagsBits.ManageMessages;
const MAX_RESULTS = 25;

// Transcripts are plain text files written by src/tickets.js when a ticket is closed.
function transcriptFiles() {
  try {
    return fs
      .readdirSync(config.transcriptDir)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => {
        const full = path.join(config.transcriptDir, name);
        return { name, full, mtime: fs.statSync(full).mtimeMs };
      });
  } catch {
    return [];
  }
}

module.exports = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('transcript')
    .setDescription('Search the archived ticket transcripts')
    .setDefaultMemberPermissions(STAFF)
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Search every transcript for a word or phrase')
        .addStringOption((option) => option.setName('query').setDescription('Text to look for').setRequired(true).setMaxLength(200)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List the most recent transcripts')),

  async execute(interaction) {
    if (!hasPerm(interaction, STAFF)) return fail(interaction, 'You need Manage Messages to use transcripts.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const files = transcriptFiles();
    if (!files.length) return interaction.editReply({ embeds: [makeEmbed('info', 'No transcripts', 'No ticket has been archived yet.')] });

    if (interaction.options.getSubcommand() === 'list') {
      const lines = files
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_RESULTS)
        .map((file) => `\`${file.name}\` — <t:${Math.floor(file.mtime / 1000)}:R>`);
      return interaction.editReply({
        embeds: [makeEmbed('info', `🗂️ Recent transcripts (${files.length})`, lines.join('\n'))],
      });
    }

    const query = interaction.options.getString('query', true).trim().toLowerCase();
    const matches = [];
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file.full, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase().includes(query)) {
          matches.push({ file: file.name, line: lines[index].trim(), number: index + 1 });
          if (matches.length >= MAX_RESULTS) break;
        }
      }
      if (matches.length >= MAX_RESULTS) break;
    }

    if (!matches.length) {
      return interaction.editReply({
        embeds: [makeEmbed('info', 'No match', `No transcript contains **${truncate(query, 100)}**.`)],
      });
    }

    const body = matches
      .map((match) => `**${match.file}** line ${match.number}\n> ${truncate(match.line, 200)}`)
      .join('\n\n');
    return interaction.editReply({
      embeds: [
        makeEmbed(
          'info',
          `🔎 ${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} match(es)`,
          truncate(body, 3900),
        ),
      ],
    });
  },
};
