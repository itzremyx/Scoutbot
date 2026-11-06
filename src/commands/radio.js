const { SlashCommandBuilder } = require('discord.js');
const { fail } = require('../utils');
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

  guildOnly: true,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();
    try {
      if (sub === 'play') {
        const track = await radio.start(interaction.guild, voiceChannelOf(interaction), interaction.options.getString('query'));
        return interaction.editReply(`Now playing **${track.title}** in ${interaction.member.voice.channel}.`);
      }
      if (sub === 'pause') {
        return interaction.editReply(radio.pause(interaction.guild.id) ? 'Paused.' : 'Nothing is playing.');
      }
      if (sub === 'resume') {
        return interaction.editReply(radio.resume(interaction.guild.id) ? 'Resumed.' : 'Nothing is paused.');
      }
      if (sub === 'stop') {
        return interaction.editReply((await radio.stop(interaction.guild)) ? 'Stopped and left the voice channel.' : 'The radio is not playing.');
      }
      const track = radio.nowPlaying(interaction.guild.id);
      return interaction.editReply(track ? `Now playing **${track.title}**.` : 'Nothing is playing.');
    } catch (error) {
      await fail(interaction, error.message || 'Could not play the radio.');
    }
  },
};
