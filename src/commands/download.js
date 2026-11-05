const path = require('path');
const { MessageFlags, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');

const COLOR = 0xffb02e;
const BANNER = path.join(__dirname, '..', '..', 'assets', 'download-banner.png');
const GITHUB_URL = 'https://github.com/gentraxyz/scoutcode';
const WEBSITE_URL = 'https://scoutcode.dev';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Download ScoutCode — the coding harness for any model'),

  async execute(interaction) {
    const banner = new AttachmentBuilder(BANNER).setName('scoutcode-download.png');
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('🚀  Download ScoutCode')
      .setURL(WEBSITE_URL)
      .setDescription(
        'ScoutCode is the coding harness that lets you bring your own AI model into your projects.\n\n' +
        '**Free models, offline-ready configs and a local-first workflow.** Grab the latest release and start building.',
      )
      .setImage('attachment://scoutcode-download.png')
      .addFields(
        { name: 'Platform', value: '🪟 **Windows 10/11** (x64) — current release', inline: true },
        { name: 'Version', value: '`0.1.16`', inline: true },
        { name: 'Source', value: 'Open source on [GitHub](' + GITHUB_URL + ')', inline: true },
      )
      .setFooter({ text: 'ScoutCode  •  scoutcode.dev' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Download Windows')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🪟')
        .setURL(WEBSITE_URL + '/download/windows'),
      new ButtonBuilder()
        .setLabel('Mac (coming soon)')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setLabel('GitHub')
        .setStyle(ButtonStyle.Link)
        .setEmoji('⭐')
        .setURL(GITHUB_URL),
      new ButtonBuilder()
        .setLabel('Website')
        .setStyle(ButtonStyle.Link)
        .setEmoji('🌐')
        .setURL(WEBSITE_URL),
    );

    return interaction.reply({ embeds: [embed], files: [banner], components: [row], flags: MessageFlags.Ephemeral });
  },
};
