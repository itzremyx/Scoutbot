const path = require('path');
const {
  MessageFlags,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} = require('discord.js');

const COLOR = 0xffb02e;
const BANNER = path.join(__dirname, '..', '..', 'assets', 'download-banner.png');
const GITHUB_URL = 'https://github.com/gentraxyz/scoutcode';
const WEBSITE_URL = 'https://scoutcode.dev';
const WINDOWS_URL = WEBSITE_URL + '/download/windows';
const FALLBACK_VERSION = '0.1.16';

async function latestVersion() {
  try {
    const updates = require('../updates');
    const log = await updates.latestChangelog();
    const version = String(log?.version || '').replace(/^v/i, '').trim();
    return version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Download ScoutCode — the coding harness for any model'),

  async execute(interaction) {
    const version = await latestVersion();
    const banner = new AttachmentBuilder(BANNER).setName('scoutcode-download.png');

    const gallery = new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder()
        .setURL('attachment://scoutcode-download.png')
        .setDescription('ScoutCode — download'),
    );

    const title = new TextDisplayBuilder().setContent(
      '## [ScoutCode](' + WEBSITE_URL + ')\n' +
      'The coding harness for any model.',
    );

    const platforms = new TextDisplayBuilder().setContent(
      '**Latest version:** `v' + version + '`\n\n' +
      'Windows · Windows 10 / 11 (x64)\n' +
      'macOS · coming soon',
    );

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Download Windows')
        .setStyle(ButtonStyle.Link)
        .setEmoji('🪟')
        .setURL(WINDOWS_URL),
      new ButtonBuilder()
        .setLabel('Source code')
        .setStyle(ButtonStyle.Link)
        .setEmoji('⭐')
        .setURL(GITHUB_URL),
      new ButtonBuilder()
        .setLabel('Website')
        .setStyle(ButtonStyle.Link)
        .setEmoji('🌐')
        .setURL(WEBSITE_URL),
    );

    const install = new TextDisplayBuilder().setContent(
      '## How to install\n' +
      'Download the `.exe`, open it and follow the installer. Windows 10 or 11 on 64-bit is required.\n\n' +
      '-# macOS is coming soon. Links update automatically with every new version.',
    );

    const container = new ContainerBuilder()
      .setAccentColor(COLOR)
      .addMediaGalleryComponents(gallery)
      .addTextDisplayComponents(title)
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(platforms)
      .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
      .addActionRowComponents(buttons)
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(install);

    await interaction.deferReply();
    const sent = await interaction.channel.send({
      components: [container],
      files: [banner],
      flags: MessageFlags.IsComponentsV2,
    });
    await interaction.deleteReply().catch(() => {});
    const invocation = await interaction.channel.messages.fetch({ limit: 10 }).catch(() => null);
    const mine = invocation?.find((message) => message.interaction?.id === interaction.id);
    if (mine) await mine.delete().catch(() => {});
    return sent;
  },
};
