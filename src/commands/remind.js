const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { parseDuration } = require('../giveaways');
const { addReminder, cancelReminder, userReminders, MAX_PER_USER } = require('../reminders');
const { fail, makeEmbed, truncate } = require('../utils');

// Works in servers and in DMs, so no guildOnly here.
const remind = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a personal reminder I will send you later')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Remind me about something')
        .addStringOption((option) =>
          option.setName('duration').setDescription('How long from now, like 10m, 2h or 1d').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('text').setDescription('What should I remind you about?').setRequired(true).setMaxLength(400),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show your pending reminders'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel one of your pending reminders')
        .addIntegerOption((option) => option.setName('id').setDescription('ID from /remind list').setRequired(true).setMinValue(1)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const durationMs = parseDuration(interaction.options.getString('duration', true));
      if (!durationMs) {
        return fail(interaction, 'Invalid duration. Use something like `10m`, `2h`, `1d` or `1h 30m` (1 minute to 30 days).');
      }

      const text = interaction.options.getString('text', true).trim();
      if (!text) return fail(interaction, 'The reminder text cannot be empty.');

      const result = addReminder({
        userId: interaction.user.id,
        // In a server the reminder is posted in that channel (falling back to a DM if the channel
        // is gone); in DMs channelId stays null and it is sent as a DM.
        channelId: interaction.guildId ? interaction.channelId : null,
        guildId: interaction.guildId ?? null,
        delayMs: durationMs,
        text,
      });
      if (result.error) return fail(interaction, result.error);

      const dueAt = result.reminder.dueAt;
      return interaction.reply({
        embeds: [
          makeEmbed(
            'success',
            '⏰ Reminder set',
            `I will remind you about:\n> ${truncate(text, 300)}\n\n<t:${Math.floor(dueAt / 1000)}:R> — reminder #${result.reminder.id} (${result.reminder.channelId ? 'in this channel' : 'by DM'}).`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const items = userReminders(interaction.user.id);
      if (!items.length) {
        return interaction.reply({
          embeds: [makeEmbed('info', 'No reminders', 'You have no pending reminders. Set one with `/remind set`.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const lines = items.map((r) => `**#${r.id}** • <t:${Math.floor(r.dueAt / 1000)}:R>\n${r.text}`);
      return interaction.reply({
        embeds: [
          makeEmbed('info', `⏰ Your reminders (${items.length}/${MAX_PER_USER})`, truncate(lines.join('\n\n'), 4000)),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // cancel
    const id = interaction.options.getInteger('id', true);
    const removed = cancelReminder(interaction.user.id, id);
    if (!removed) return fail(interaction, `You have no pending reminder #${id}.`);
    return interaction.reply({
      embeds: [makeEmbed('success', 'Reminder cancelled', `Cancelled reminder #${id}: ${truncate(removed.text, 300)}`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

module.exports = { remind };
