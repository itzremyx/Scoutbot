const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const ai = require('../ai');
const memory = require('../memory');
const { fail, hasPerm, makeEmbed, truncate } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('See and manage what the bot remembers')
    .addSubcommand((sub) => sub.setName('show').setDescription('List what the bot remembers about you'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Teach the bot something about you')
        .addStringOption((option) =>
          option.setName('fact').setDescription('e.g. "My name is Sam"').setRequired(true).setMaxLength(300),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('forget')
        .setDescription('Remove one remembered fact')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('Fact ID from /memory show').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Forget everything the bot knows about you'))
    .addSubcommand((sub) =>
      sub.setName('chat-reset').setDescription('Clear the bot’s recent chat history in this channel'),
    )
    .addSubcommand((sub) =>
      sub.setName('server-list').setDescription('List the rules this server’s admins gave the bot'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('server-add')
        .setDescription('Add a rule the bot always follows in this server (Manage Server)')
        .addStringOption((option) =>
          option.setName('rule').setDescription('e.g. "Always answer in English"').setRequired(true).setMaxLength(300),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('server-forget')
        .setDescription('Remove a server rule (Manage Server)')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('Rule ID from /memory server-list').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('pending').setDescription('List what the bot learned and is waiting to use (Manage Server)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('approve')
        .setDescription('Approve a pending fact so the bot uses it (Manage Server)')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('Pending ID from /memory pending').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reject')
        .setDescription('Reject a pending fact (Manage Server)')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('Pending ID from /memory pending').setRequired(true).setMinValue(1),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (['server-list', 'server-add', 'server-forget', 'pending', 'approve', 'reject'].includes(sub)) {
      if (!interaction.guild) {
        return fail(interaction, 'Server rules only work in a server.');
      }
      const guildId = interaction.guild.id;

      if (sub === 'server-list') {
        const rules = memory.getInstructions(guildId);
        const body = rules.length
          ? rules.map((rule) => `**#${rule.id}** ${rule.text}`).join('\n')
          : 'No server rules yet. Admins can add one with `/memory server-add`.';
        return interaction.reply({
          embeds: [makeEmbed('info', 'Server rules', truncate(body, 4000))],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!hasPerm(interaction, PermissionFlagsBits.ManageGuild)) {
        return fail(interaction, 'Only members with Manage Server can change server rules or approve memories.');
      }

      if (sub === 'pending') {
        const items = memory.getPending(guildId);
        const body = items.length
          ? items
              .map((item) => {
                const action = item.text ? item.text : '(remove only)';
                const change = item.replaces !== null ? ` replaces fact #${item.replaces}` : '';
                return `**#${item.id}** <@${item.userId}>: ${action}${change}`;
              })
              .join('\n')
          : 'Nothing is waiting for approval.';
        return interaction.reply({
          embeds: [makeEmbed('info', 'Pending memories', truncate(body, 4000))],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'approve' || sub === 'reject') {
        const id = interaction.options.getInteger('id', true);
        const done = sub === 'approve' ? memory.approvePendingFact(guildId, id) : memory.rejectPendingFact(guildId, id);
        const ok = Boolean(done);
        const text = ok
          ? `${sub === 'approve' ? 'Approved' : 'Rejected'} pending #${id}.`
          : `No pending item #${id}.`;
        return interaction.reply({ embeds: [makeEmbed(ok ? 'success' : 'error', 'Pending memories', text)], flags: MessageFlags.Ephemeral });
      }

      if (sub === 'server-add') {
        const saved = memory.addInstruction(guildId, interaction.options.getString('rule', true));
        if (saved === 'full') {
          return fail(interaction, `The server already has ${memory.MAX_INSTRUCTIONS} rules. Remove one first.`);
        }
        const text = saved ? `Got it, I'll always follow: ${saved.text}` : 'That rule already exists, or the text was empty.';
        return interaction.reply({ embeds: [makeEmbed(saved ? 'success' : 'info', 'Server rule', text)] });
      }

      const id = interaction.options.getInteger('id', true);
      const removed = memory.removeInstruction(guildId, id);
      const text = removed ? `Removed rule #${id}.` : `No server rule #${id}.`;
      return interaction.reply({ embeds: [makeEmbed(removed ? 'success' : 'error', 'Server rule', text)] });
    }

    if (sub === 'show') {
      const facts = memory.getFacts(userId);
      const body = facts.length
        ? facts.map((fact) => `**#${fact.id}** ${fact.text}`).join('\n')
        : 'I don’t remember anything about you yet. Chat with me or use `/memory add`.';
      return interaction.reply({
        embeds: [makeEmbed('info', 'What I remember about you', truncate(body, 4000))],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'add') {
      const fact = memory.addFact(userId, interaction.options.getString('fact', true));
      const text = fact ? `Got it, I'll remember: ${fact.text}` : 'I already know that, or the text was empty.';
      return interaction.reply({ embeds: [makeEmbed(fact ? 'success' : 'info', 'Memory', text)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'forget') {
      const id = interaction.options.getInteger('id', true);
      const removed = memory.removeFact(userId, id);
      const text = removed ? `Forgot fact #${id}.` : `You have no fact #${id}.`;
      return interaction.reply({ embeds: [makeEmbed(removed ? 'success' : 'error', 'Memory', text)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'clear') {
      memory.clearFacts(userId);
      return interaction.reply({
        embeds: [makeEmbed('success', 'Memory cleared', 'I have forgotten everything about you.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    ai.resetConversation(interaction.channelId);
    return interaction.reply({
      embeds: [makeEmbed('success', 'Chat reset', 'I cleared my recent chat history for this channel.')],
      flags: MessageFlags.Ephemeral,
    });
  },
};
