const { SlashCommandBuilder } = require('discord.js');
const { requireGuild, handleError } = require('../utils');
const radio = require('../radio');

function voiceChannelOf(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error('Join a voice channel first.');
  return channel;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Play ScoutRadio in a voice channel and show the current track')
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('play')
      .setDescription('Play a link or search for a song in your voice channel')
      .addStringOption((option) => option.setName('query').setDescription('A YouTube link, a direct stream URL, or a song name').setRequired(true)))
    .addSubcommand((sub) => sub.setName('pause').setDescription('Pause the radio'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('Resume the radio'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Stop the radio and leave the voice channel'))
    .addSubcommand((sub) => sub.setName('now').setDescription('Show what is playing')),

  async execute(interaction) {
    if (!(await requireGuild(interaction))) return;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();
    try {
      if (sub === 'play') {
        const track = await radio.start(interaction.guild, voiceChannelOf(interaction), interaction.options.getString('query'));
        await interaction.editReply(`Playing **${track.title}** in ${interaction.member.voice.channel}.`);
        return;
      }
      if (sub === 'pause') {
        const paused = radio.pause(interaction.guild.id);
        await interaction.editReply(paused ? 'Paused.' : 'Nothing is playing.');
        return;
      }
      if (sub === 'resume') {
        const resumed = radio.resume(interaction.guild.id);
        await interaction.editReply(resumed ? 'Resumed.' : 'Nothing is paused.');
        return;
      }
      if (sub === 'stop') {
        const stopped = await radio.stop(interaction.guild);
        await interaction.editReply(stopped ? 'Stopped and left the voice channel.' : 'The radio is not playing.');
        return;
      }
      const track = radio.nowPlaying(interaction.guild.id);
      await interaction.editReply(track ? `Now playing **${track.title}**.` : 'Nothing is playing.');
    } catch (error) {
      await handleError(interaction, error);
    }
  },
};
