import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import play from 'play-dl';

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

/** @type {Map<string, { queue: string[], player: import('@discordjs/voice').AudioPlayer, connection: import('@discordjs/voice').VoiceConnection | null, playing: boolean }>} */
const guildState = new Map();

function getState(guildId) {
  if (!guildState.has(guildId)) {
    const player = createAudioPlayer();
    guildState.set(guildId, {
      queue: [],
      player,
      connection: null,
      playing: false,
    });
    player.on(AudioPlayerStatus.Idle, () => {
      const s = guildState.get(guildId);
      if (!s) return;
      s.playing = false;
      void playNext(guildId);
    });
    player.on('error', (e) => {
      console.error('AudioPlayer error', guildId, e);
    });
  }
  return guildState.get(guildId);
}

async function playNext(guildId) {
  const s = guildState.get(guildId);
  if (!s || !s.connection) return;
  const next = s.queue.shift();
  if (!next) return;
  try {
    if (play.yt_validate(next) !== 'video') {
      const searched = await play.search(next, { limit: 1, source: { youtube: 'video' } });
      const first = searched?.[0];
      if (!first?.url) throw new Error('Ничего не найдено');
      await streamUrl(guildId, first.url, first.title || next);
      return;
    }
    await streamUrl(guildId, next, next);
  } catch (e) {
    console.error('playNext', e);
    s.playing = false;
    void playNext(guildId);
  }
}

async function streamUrl(guildId, url, label) {
  const s = guildState.get(guildId);
  if (!s?.connection) return;
  const stream = await play.stream(url, { discordPlayerCompatibility: true });
  const resource = createAudioResource(stream.stream, {
    inputType: stream.type,
    metadata: { title: label },
  });
  s.player.play(resource);
  s.playing = true;
  console.log(`[music] ${guildId} playing: ${label}`);
}

/**
 * @param {import('discord.js').VoiceBasedChannel} channel
 * @param {string} queryOrUrl
 */
export async function enqueue(channel, queryOrUrl) {
  const guildId = channel.guild.id;
  const s = getState(guildId);
  if (!s.connection || s.connection.joinConfig.channelId !== channel.id) {
    s.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    s.connection.subscribe(s.player);
  }
  s.queue.push(queryOrUrl);
  if (!s.playing && s.queue.length === 1) {
    await playNext(guildId);
  }
}

export function skip(guildId) {
  const s = guildState.get(guildId);
  if (!s?.player) return false;
  s.player.stop(true);
  return true;
}

export function stopAndLeave(guildId) {
  const s = guildState.get(guildId);
  if (!s) return;
  s.queue.length = 0;
  s.playing = false;
  s.player.stop(true);
  s.connection?.destroy();
  s.connection = null;
}
