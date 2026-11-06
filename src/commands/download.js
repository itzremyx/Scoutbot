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
      '# [ScoutCode](' + WEBSITE_URL + ')\n' +
      'The coding harness for any model.',
    );

    const body = new TextDisplayBuilder().setContent(
      'Bring your own AI model into your projects. Free models, offline-ready configs and a local-first workflow.\n\n' +
      '**Platform** — Windows 10/11 (x64), current release\n' +
      '**Version** — `' + version + '`\n' +
      '**Source** — open source on [GitHub](' + GITHUB_URL + ')\n' +
      '**Mac** — coming soon',
    );

    const pad = (name) => new ButtonBuilder().setCustomId('download:pad:' + name).setLabel('​').setStyle(ButtonStyle.Secondary).setDisabled(true);
    const downloads = new ActionRowBuilder().addComponents(
      pad('left'),
      new ButtonBuilder().setLabel('Download Windows').setStyle(ButtonStyle.Link).setEmoji('🪟').setURL(WINDOWS_URL),
      new ButtonBuilder().setCustomId('download:mac-soon').setLabel('Mac (coming soon)').setStyle(ButtonStyle.Secondary).setDisabled(true),
      pad('right'),
    );
    const links = new ActionRowBuilder().addComponents(
      pad('github-left'),
      new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setEmoji('⭐').setURL(GITHUB_URL),
      new ButtonBuilder().setLabel('Website').setStyle(ButtonStyle.Link).setEmoji('🌐').setURL(WEBSITE_URL),
      pad('github-right'),
    );

    const container = new ContainerBuilder()
      .setAccentColor(COLOR)
      .addMediaGalleryComponents(gallery)
      .addTextDisplayComponents(title)
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(body)
      .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
      .addActionRowComponents(downloads)
      .addActionRowComponents(links);

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
