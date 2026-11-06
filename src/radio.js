const { spawn } = require('child_process');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const play = require('play-dl');
const config = require('./config');

// prism-media only auto-detects an ffmpeg binary on PATH. Point it at the bundled static build
// when the host has none of its own, so playback works without a system install.
if (!process.env.FFMPEG_PATH) {
  try { process.env.FFMPEG_PATH = require('ffmpeg-static') || ''; } catch { /* no bundled ffmpeg */ }
}

const TITLE_LIMIT = 90;
const DEFAULT_PREFIX = 'Radio';

const sessions = new Map();

function session(guildId) {
  return sessions.get(guildId) ?? null;
}

function clip(text, max = TITLE_LIMIT) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

// play-dl needs either a trusted innertube client or YouTube cookies. Both are optional: without
// them a direct stream URL still plays, and a YouTube link fails with a clear message instead.
let playReady = null;
function preparePlay() {
  if (playReady) return playReady;
  playReady = (async () => {
    if (config.radio.youtubeCookies) {
      await play.setToken({ youtube: { cookie: config.radio.youtubeCookies } }).catch(() => {});
    }
    return true;
  })();
  return playReady;
}

// yt-dlp prints one JSON object with -J. Cookies, when configured, are passed as a file so the
// secret never appears in the process arguments.
function ytdlpInfo(url) {
  return new Promise((resolve) => {
    const args = ['-J', '--no-warnings', '--no-playlist', '-f', 'bestaudio/best'];
    if (config.radio.cookiesFile) args.push('--cookies', config.radio.cookiesFile);
    args.push(url);
    let out = '';
    let child;
    try {
      child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 25_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

// Resolves a query into something playable: a direct audio URL, a YouTube link, or a search term
// that resolves to the first YouTube result. Throws a user-facing Error when nothing matches.
async function resolveTrack(query) {
  const input = String(query || '').trim();
  if (!input) throw new Error('Give me a link or a song name.');

  if (/^https?:\/\//i.test(input) && play.yt_validate(input) !== 'video') {
    const info = await ytdlpInfo(input);
    if (info?.url) return { title: clip(info.title) || 'Radio stream', url: info.url, direct: true };
    return { title: 'Radio stream', url: input, direct: true };
  }

  await preparePlay();
  let target = input;
  if (play.yt_validate(input) !== 'video') {
    const results = await play.search(input, { limit: 1 }).catch(() => []);
    if (!results.length) throw new Error(`No YouTube result for "${clip(input, 60)}".`);
    target = results[0].url;
  }
  const info = await play.video_basic_info(target);
  const details = info.video_details;
  return { title: clip(details.title) || 'Unknown title', url: details.url || target, direct: false };
}

// Opens the audio for a track. YouTube goes through play-dl (it returns an opus stream); anything
// else is demuxed by ffmpeg from the raw URL.
async function openStream(track) {
  if (!track.direct) {
    const stream = await play.stream(track.url, { discordPlayerCompatibility: true });
    return { body: stream.stream, type: stream.type };
  }
  const response = await fetch(track.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error(`The stream returned ${response.status}.`);
  const { stream, type } = await demuxProbe(response.body);
  return { body: stream, type: type ?? StreamType.Arbitrary };
}

function channelName(track) {
  const prefix = config.radio.channelPrefix || DEFAULT_PREFIX;
  return clip(`${prefix} | ${track.title}`, 100);
}

// Remembers the channel's real name and shows the current track in it. Restored when playback ends.
async function showTrack(guild, channel, track) {
  if (!config.radio.renameChannel || !channel?.manageable) return;
  const sessionForGuild = session(guild.id);
  if (sessionForGuild && sessionForGuild.originalName === undefined) sessionForGuild.originalName = channel.name;
  await channel.setName(channelName(track)).catch(() => {});
}

async function restoreName(guild, channel) {
  const current = session(guild.id);
  if (!current || current.originalName === undefined || !channel?.manageable) return;
  await channel.setName(current.originalName).catch(() => {});
  current.originalName = undefined;
}

function destroy(guildId) {
  const current = sessions.get(guildId);
  if (!current) return;
  sessions.delete(guildId);
  current.player.stop(true);
  current.connection.destroy();
}

// Joins the channel the member is in and starts playback, replacing anything already playing.
async function start(guild, voiceChannel, query) {
  const track = await resolveTrack(query);
  let current = session(guild.id);

  if (!current || current.connection.joinConfig.channelId !== voiceChannel.id) {
    if (current) destroy(guild.id);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(player);
    current = { connection, player, channel: voiceChannel, track: null, originalName: undefined };
    sessions.set(guild.id, current);

    player.on(AudioPlayerStatus.Idle, () => {
      const active = session(guild.id);
      if (!active) return;
      active.track = null;
      restoreName(guild, active.channel).catch(() => {});
    });
    player.on('error', () => {
      const active = session(guild.id);
      if (active) active.track = null;
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        stop(guild);
      }
    });
  }

  const { body, type } = await openStream(track);
  current.player.play(createAudioResource(body, { inputType: type, inlineVolume: false }));
  current.track = track;
  current.channel = voiceChannel;
  await showTrack(guild, voiceChannel, track);
  return track;
}

function pause(guildId) {
  const current = session(guildId);
  if (!current?.track) return false;
  return current.player.pause(true);
}

function resume(guildId) {
  const current = session(guildId);
  if (!current) return false;
  return current.player.unpause();
}

async function stop(guild) {
  const current = session(guild.id);
  if (!current) return false;
  await restoreName(guild, current.channel);
  destroy(guild.id);
  return true;
}

function nowPlaying(guildId) {
  return session(guildId)?.track ?? null;
}

module.exports = { start, pause, resume, stop, nowPlaying, session };
