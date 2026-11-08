const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const store = require('../storage');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

const MAX_TAGS = 100;
const MAX_CONTENT = 1900;

// Tags are per-guild saved answers: /tag show name posts the saved text. The key is normalised
// so "API Key" and "api-key" point at the same entry.
function tagStore(guildId) {
  const guild = store.guild(guildId);
  guild.tags ??= {};
  return guild.tags;
}

const normalize = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, '-');

function nameOption(option) {
  return option.setName('name').setDescription('Tag name').setRequired(true).setMaxLength(50);
}

function contentOption(option) {
  return option.setName('content').setDescription('Text shown when the tag is used').setRequired(true).setMaxLength(MAX_CONTENT);
}

const MANAGE = PermissionFlagsBits.ManageMessages;

async function manageCheck(interaction) {
  if (!hasPerm(interaction, MANAGE)) {
    await fail(interaction, 'You need the Manage Messages permission to edit tags.');
    return false;
  }
  return true;
}

module.exports = {
  guildOnly: true,

  data: new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Saved answers you can show with a single command')
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('Post a saved tag').addStringOption(nameOption),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List every saved tag'))
    .addSubcommand((sub) =>
      sub.setName('add').setDescription('Save a new tag').addStringOption(nameOption).addStringOption(contentOption),
    )
    .addSubcommand((sub) =>
      sub.setName('edit').setDescription('Replace the text of a tag').addStringOption(nameOption).addStringOption(contentOption),
    )
    .addSubcommand((sub) =>
      sub.setName('remove').setDescription('Delete a tag').addStringOption(nameOption),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const tags = tagStore(interaction.guild.id);

    if (sub === 'show') {
      const name = normalize(interaction.options.getString('name', true));
      const tag = tags[name];
      if (!tag) return fail(interaction, `There is no tag named **${name}**. Use \`/tag list\` to see them.`);
      return interaction.reply({
        embeds: [makeEmbed('info', `🏷️ ${name}`, truncate(tag.content, 3900))],
        allowedMentions: { parse: [] },
      });
    }

    if (sub === 'list') {
      const names = Object.keys(tags).sort();
      if (!names.length) return fail(interaction, 'This server has no tags yet. Use `/tag add` to create one.');
      return interaction.reply({
        embeds: [
          makeEmbed(
            'info',
            `🏷️ Saved tags (${names.length})`,
            truncate(names.map((name) => `\`${name}\``).join(', '), 3900),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!(await manageCheck(interaction))) return;

    if (sub === 'add') {
      const name = normalize(interaction.options.getString('name', true));
      if (!name) return fail(interaction, 'The tag name cannot be empty.');
      if (tags[name]) return fail(interaction, `A tag named **${name}** already exists. Use \`/tag edit\`.`);
      if (Object.keys(tags).length >= MAX_TAGS) return fail(interaction, `The server already has ${MAX_TAGS} tags. Remove one first.`);

      tags[name] = {
        content: interaction.options.getString('content', true).trim(),
        createdBy: interaction.user.id,
        createdAt: Date.now(),
      };
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Tag saved', `Use \`/tag show name:${name}\` to post it.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const name = normalize(interaction.options.getString('name', true));
    if (!tags[name]) return fail(interaction, `There is no tag named **${name}**.`);

    if (sub === 'edit') {
      tags[name].content = interaction.options.getString('content', true).trim();
      tags[name].editedBy = interaction.user.id;
      tags[name].editedAt = Date.now();
      store.save();
      return interaction.reply({
        embeds: [makeEmbed('success', 'Tag updated', `**${name}** now has new text.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    delete tags[name];
    store.save();
    return interaction.reply({
      embeds: [makeEmbed('success', 'Tag removed', `**${name}** was deleted.`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
