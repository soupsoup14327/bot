/**
 * Локальное выравнивание громкости между треками: yt-dlp → ffmpeg (-af) → s16le 48kHz stereo → @discordjs/voice (StreamType.Raw).
 * Без внешних API; используется ffmpeg-static из зависимостей бота.
 */
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * @returns {boolean}
 */
export function isAudioNormalizeEnabled() {
  const v = process.env.AUDIO_NORMALIZE;
  if (v === undefined || v === '') return true;
  const lower = String(v).trim().toLowerCase();
  if (lower === '0' || lower === 'false' || lower === 'off' || lower === 'no') return false;
  return true;
}

/**
 * Цепочка -af. По умолчанию динамическая нормализация (подходит для потока и разной громкости).
 * Переопределение: переменная AUDIO_FFMPEG_AF (полная строка фильтра).
 * @returns {string}
 */
function getAudioNormalizeAf() {
  const custom = process.env.AUDIO_FFMPEG_AF?.trim();
  if (custom) return custom;
  return 'dynaudnorm=f=300:g=15';
}

/**
 * Подключает второй процесс ffmpeg после yt-dlp: любой bestaudio в PCM для голосового пайплайна.
 * @param {import('node:child_process').ChildProcess} ytdlpProc
 * @returns {import('node:child_process').ChildProcess | null}
 */
export function spawnFfmpegNormalizeAfterYtdlp(ytdlpProc) {
  if (!isAudioNormalizeEnabled()) return null;
  if (!ffmpegPath) {
    console.warn('[audio-normalize] ffmpeg-static недоступен — нормализация отключена');
    return null;
  }
  if (!ytdlpProc.stdout) return null;

  const af = getAudioNormalizeAf();
  const ff = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-af',
      af,
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  ytdlpProc.stdout.pipe(ff.stdin);
  ff.stdin.on('error', () => {});

  return ff;
}
