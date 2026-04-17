/**
 * youtube-search.js
 * Весь поиск, скоринг и разрешение YouTube-ссылок — изолировано от логики плеера.
 *
 * Публичное API:
 *   resolveYoutubeFromQuery(query)        — строка → { url, label }
 *   resolveYoutubeDisplayLabel(queryOrUrl)— watch URL → заголовок ролика (или исходная строка)
 *   pickDistinctTrackVideos(theme, count) — тема → [{ title, url }, ...]
 *
 */

import play from 'play-dl';
import youtubeDl from 'youtube-dl-exec';
import { applyLocalBoost, isBridgeEnabled } from './recommendation-bridge.js';
import { isAutoplayDebugEnabled } from './autoplay-telemetry.js';

// ---------------------------------------------------------------------------
// Search-process semaphore
// Limits concurrent yt-dlp *search* processes (separate from the stream
// semaphore in music.js). Without this, 2-4 allQueries × 5 internal
// fallback-queries = 10-20 simultaneous Python processes, which stalls the
// audio stream and causes the "bot hung after first autoplay" symptom.
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_YTDLP_SEARCH = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_YTDLP_SEARCH) || 5,
);
let _searchActive = 0;
/** @type {Array<() => void>} */
const _searchQueue = [];

function acquireSearchSlot() {
  return new Promise((resolve) => {
    if (_searchActive < MAX_CONCURRENT_YTDLP_SEARCH) {
      _searchActive++;
      resolve();
    } else {
      _searchQueue.push(resolve);
    }
  });
}

function releaseSearchSlot() {
  const next = _searchQueue.shift();
  if (next) {
    next();
  } else {
    _searchActive--;
  }
}

// ---------------------------------------------------------------------------
// YouTube URL normalization (Shorts, music, youtu.be, Discord <url>, etc.)
// ---------------------------------------------------------------------------

/**
 * Extracts an 11-char YouTube video id from common URL shapes.
 * play.yt_validate only accepts a subset; this runs first so paste always works.
 * @param {string} s
 * @returns {string | null}
 */
function extractYoutubeVideoId(s) {
  const t = String(s).trim();
  if (!t) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})(?:[&#[/]|$)/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?&#]|$)/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[?&#]|$)/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[?&#]|$)/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})(?:[?&#]|$)/,
    /music\.youtube\.com\/watch\?[^#]*[&?]v=([a-zA-Z0-9_-]{11})/,
    /m\.youtube\.com\/watch\?[^#]*[&?]v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1];
  }
  const watch = t.match(/youtube\.com\/watch\?([^#]+)/);
  if (watch) {
    const vm = watch[1].match(/(?:^|&)v=([a-zA-Z0-9_-]{11})(?:&|$)/);
    if (vm) return vm[1];
  }
  return null;
}

/**
 * If the string is (or contains) a YouTube watch URL, returns canonical
 * `https://www.youtube.com/watch?v=VIDEO_ID`. Strips Discord's `<https://...>` wrapper.
 * Otherwise returns `null` (caller keeps treating input as search text).
 * @param {string} input
 * @returns {string | null}
 */
export function tryNormalizeYoutubeUrl(input) {
  let s = String(input).trim();
  if (!s) return null;
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  const id = extractYoutubeVideoId(s);
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

// ---------------------------------------------------------------------------
// Константы фильтрации
// ---------------------------------------------------------------------------

const BAD_TITLE_HINTS = [
  'обзор',
  'разбор',
  'распаковка',
  'рассказ',
  'рассказываю',
  'топ-10',
  'топ 10',
  ' топ ',
  'top 10',
  'top 5',
  ' фактов',
  'факты о',
  '10 факт',
  'всё об',
  'все об',
  'об этом аниме',
  'об аниме',
  'explained',
  'review',
  'reaction',
  'reacts',
  ' podcast',
  'documentary',
  ' стрим',
  'сюжет',
  'история аниме',
  'lore ',
  ' лор',
  'ending explained',
  'everything about',
  'who is',
  'что такое',
  'кратко о',
  'за 10 минут',
  'за 15 минут',
  'за 20 минут',
  'ranking',
  'tier list',
  'worth watch',
  'стоит смотреть',
  'стоит ли',
  'trailer',
  'трейлер',
  'teaser',
  'тизер',
  'preview',
  'превью',
  'sneak peek',
  'tv spot',
  'анонс',
  'gameplay',
  'walkthrough',
  'типичн',
  'vs ',
  'comparison',
  'сравнен',
  'спойлер',
  'spoiler',
  'рекап',
  'recap',
  'нарезк',
  'compilation',
  'moments',
  'смешн',
  'прикол',
  'смысл ',
  'meaning of',
  'secret of',
  'тайн',
  'секрет',
  'теория',
  'theory',
  'hidden meaning',
  'true story',
  'значение',
  'amv',
  '「amv',
  '【amv】',
  '【mad】',
  '「mad」',
  '[mad]',
  'anime mix',
  'anime fights',
  'best anime fight',
];

const GOOD_TITLE_HINTS = [
  'opening',
  ' op ',
  '[op]',
  'ending',
  ' ed ',
  '[ed]',
  'ost',
  'soundtrack',
  'theme song',
  'full version',
  'full song',
  'lyrics',
  'lyric',
  'tv size',
  'опенинг',
  'эндинг',
  'саундтрек',
  'полная версия',
  'караоке',
  'karaoke',
  'instrumental',
  'music video',
  ' mv ',
  'official',
  '公式',
];

/** Доп. минусы для подборок: квизы, «100 опенингов», часовые mix. */
const PLAYLIST_EXTRA_BAD = [
  'угадай',
  'угада',
  'guess the',
  'guess 1',
  'guess ',
  'quiz',
  'квиз',
  'challenge',
  'try to guess',
  'opening quiz',
  'anime quiz',
  'все опенинг',
  'all openings',
  'all anime',
  'hour long',
  '10 hours',
  '24/7',
  'non-stop',
  'nonstop',
  'mega mix',
  'megamix',
  'marathon',
  'hours of',
  'часов ',
  'плейлист на',
  'full album',
  'компиляц',
  'compilation',
  'tiktok compilation',
  'nightcore mix',
  'phonk mix',
  'tutorial',
  'teaches you',
  'how to make',
  'teaser trailer',
  'official preview',
];

const NON_TRACK_HARD_HINTS = [
  'unboxing',
  'распаковка',
  'reaction',
  'react',
  'review',
  'обзор',
  'tutorial',
  'teaches you',
  'how to make',
  'lesson',
  'подкаст',
  'podcast',
  'interview',
];

/** Субтитры/текст — не «категория версии» (этап 8). */
const NON_TRACK_SOFT_META_HINTS = [
  'lyrics',
  'lyric',
  'romaji',
  'translation',
  'subtitulado',
  'color coded',
];

/**
 * Категория alt-version (cover / nightcore / slowed …) — legacy blanket +16 за слово;
 * при `AUTOPLAY_ALT_VARIANTS_RELAXED=1` не штрафуем за категорию здесь (streak + junk отдельно).
 */
const NON_TRACK_SOFT_ALT_CATEGORY_HINTS = [
  'cover',
  'кавер',
  'nightcore',
  'slowed',
  'speed up',
  'sped up',
  '8d',
  'bass boosted',
];

/** Полный legacy-набор (meta + alt category). */
const NON_TRACK_SOFT_HINTS = [...NON_TRACK_SOFT_META_HINTS, ...NON_TRACK_SOFT_ALT_CATEGORY_HINTS];

/**
 * Класс C (staff v2 §13): явный junk/SEO — штраф независимо от relaxed.
 * Короткий список; расширять точечно.
 */
const JUNK_LOW_EFFORT_HINTS = [
  'tiktok compilation',
  'tiktok remix',
  'viral tiktok',
  'try not to',
  'guess the song',
  '1 hour loop',
  '10 hour loop',
  '24/7',
  'non-stop',
  'nonstop',
  'megamix',
  'marathon',
  'hours of',
  'часов ',
  'phonk mix',
  'nightcore mix',
  'bass boosted meme',
];

const INTENT_STOPWORDS = new Set([
  'official', 'audio', 'video', 'song', 'track', 'music', 'full', 'version', 'mv',
  'lyrics', 'lyric', 'live', 'cover', 'remix', 'feat', 'ft',
  'официальный', 'официально', 'официал', 'песня', 'трек', 'музыка', 'кавер', 'концерт',
  'officially', 'subtitulado', 'romaji',
]);

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Уточняет запрос, чтобы чаще находить именно трек, а не обзор/разбор. */
function augmentYoutubeSearchQuery(q) {
  const s = q.trim();
  if (!s) return s;
  const wantsTheme =
    /опенинг|опеннинг|\bopening\b|\bop\s|opening\s|\[op\]|эндинг|\bending\b|\bed\s|саундтрек|soundtrack|\bost\b|тема\s+из/i.test(
      s,
    );
  if (!wantsTheme) return s;
  if (/full\s+(song|version)|theme\s+song|lyrics|караоке|karaoke|tv\s*size/i.test(s)) return s;
  return `${s} full opening theme song lyrics`;
}

function normalizePlaylistTheme(raw) {
  return raw
    .trim()
    .replace(/опенинги|опенингов|опенингам/giu, 'opening')
    .replace(/\bops\b/giu, 'opening');
}

function buildPlaylistSearchQuery(raw) {
  const s = normalizePlaylistTheme(raw);
  if (!s) return s;
  if (/аниме|anime/i.test(s)) {
    if (/опенинг|опеннинг|opening|\bop\b|эндинг|ending|\bed\b/i.test(s)) {
      return `${s} full opening song official audio`;
    }
    return `${s} anime soundtrack official song`;
  }
  if (/хип[\s-]*хоп|hip[\s-]*hop|\brap\b|рэп/i.test(s)) {
    return `${s} hip hop song official audio`;
  }
  if (/лофай|lo[\s-]?fi|lofi/i.test(s)) {
    return `${s} lofi music single`;
  }
  return `${s} music official audio song`;
}

/** Для `ytsearchN:…` нельзя оставлять «ломающие» префикс символы. */
function sanitizeYtSearchQuery(raw) {
  return String(raw ?? '')
    .trim()
    .slice(0, 180)
    .replace(/[\r\n]+/g, ' ')
    .replace(/:/g, ' ');
}

function tokenizeIntent(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/**
 * @param {string} originalQuery
 */
function parseSearchIntent(originalQuery) {
  const q = String(originalQuery ?? '').toLowerCase();
  const tokens = tokenizeIntent(q).filter((t) => !INTENT_STOPWORDS.has(t));
  const broadIntent = /playlist|mix|compilation|best|top|hits|подборк|hour|hours|study|sleep|rainy|night drive|mood|vibe|genre|лофи|lo[\s-]?fi|chill/i.test(q);
  const wantsOfficial = /\bofficial\b|official audio|official music video|公式/i.test(q);
  const wantsCover = /\bcover\b|кавер/i.test(q);
  const wantsLive = /\blive\b|концерт|session/i.test(q);
  const wantsLyrics = /\blyrics?\b|lyric|текст|romaji|vietsub|subtit/i.test(q);
  /** Явный запрос «альтернативной» версии — не штрафуем streak-ом. */
  const wantsAlternateStyle =
    /\b(nightcore|night\s*core|slowed|sped|spedup|8d|bass\s*boosted|cover|кавер|chipmunk|reverb|gachi|vaporwave|phonk\s*edit|amv\b|fan\s*made)\b/i.test(
      q,
    );
  const exactIntent = !broadIntent && tokens.length >= 2;
  const strongAnchorTokens = tokens.slice(0, Math.min(3, tokens.length));
  const trackAnchorToken = tokens.length >= 3 ? tokens[tokens.length - 1] : '';
  const artistAnchorToken = strongAnchorTokens[0] ?? '';
  return {
    wantsOfficial,
    wantsCover,
    wantsLive,
    wantsLyrics,
    wantsAlternateStyle,
    exactIntent,
    strongAnchorTokens,
    trackAnchorToken,
    artistAnchorToken,
  };
}

/**
 * @param {string} blob
 * @param {string} channelBlob
 * @param {{ strongAnchorTokens: string[], trackAnchorToken: string }} intent
 */
function anchorMetaForVideo(blob, channelBlob, intent) {
  let hitCount = 0;
  let strongHitCount = 0;
  for (const t of intent.strongAnchorTokens) {
    const hit = blob.includes(t) || channelBlob.includes(t);
    if (hit) {
      hitCount++;
      strongHitCount++;
    }
  }
  if (intent.trackAnchorToken && (blob.includes(intent.trackAnchorToken) || channelBlob.includes(intent.trackAnchorToken))) {
    hitCount++;
  }
  const missingStrong = Math.max(0, intent.strongAnchorTokens.length - strongHitCount);
  const hasArtistAnchor = intent.artistAnchorToken
    ? (blob.includes(intent.artistAnchorToken) || channelBlob.includes(intent.artistAnchorToken))
    : false;
  const hasTrackAnchor = intent.trackAnchorToken
    ? (blob.includes(intent.trackAnchorToken) || channelBlob.includes(intent.trackAnchorToken))
    : false;
  return { hitCount, strongHitCount, missingStrong, hasArtistAnchor, hasTrackAnchor };
}

/**
 * @param {string} blob
 * @param {string} channelBlob
 * @param {boolean} videoLive
 * @param {{ wantsOfficial: boolean, wantsCover: boolean, wantsLive: boolean, wantsLyrics: boolean, exactIntent: boolean, strongAnchorTokens: string[], trackAnchorToken: string, artistAnchorToken: string }} intent
 * @param {{ hitCount: number, missingStrong: number, hasArtistAnchor: boolean, hasTrackAnchor: boolean }} anchor
 */
function scoreIntentAdjustments(blob, channelBlob, videoLive, intent, anchor) {
  let score = 0;
  const notes = {};
  const relaxed = isAutoplayAltVariantsRelaxed();
  const hasOfficialMarker = /official|vevo|topic|公式|music video|audio/.test(blob);
  const hasCoverMarker = /\bcover\b|кавер/.test(blob);
  const hasLyricsMarker = /\blyrics?\b|lyric|romaji|vietsub|subtit/.test(blob);
  const hasLiveMarker = /\blive\b|concert|session/.test(blob) || Boolean(videoLive);
  const channelLooksOfficial = /\b(topic|vevo|records?|official|music|entertainment|label)\b|公式/.test(channelBlob);
  const channelLooksFan = /\blyrics?|vietsub|subtit|fan[-\s]?made|nightcore|slowed|sped up|cover|amv|edit\b|reaction/.test(channelBlob);

  if (intent.wantsOfficial) {
    if (hasOfficialMarker) {
      score += 18;
      notes.officialBoost = 18;
    }
    if (channelLooksOfficial) {
      score += 22;
      notes.channelTrustBoost = 22;
    }
    if (channelLooksFan) {
      score -= 24;
      notes.channelTrustPenalty = 24;
    }
    if (hasLyricsMarker) {
      score -= 18;
      notes.officialLyricsPenalty = 18;
    }
    if (!relaxed && hasCoverMarker && !intent.wantsCover) {
      score -= 16;
      notes.officialCoverPenalty = 16;
    }
  }

  if (intent.wantsLive) {
    if (hasLiveMarker) {
      score += 12;
      notes.liveBoost = 12;
    } else {
      score -= 8;
      notes.liveMissPenalty = 8;
    }
  } else if (!relaxed && hasLiveMarker) {
    score -= 8;
    notes.livePenalty = 8;
  }

  if (intent.wantsCover) {
    if (hasCoverMarker) {
      score += 12;
      notes.coverBoost = 12;
    } else {
      score -= 8;
      notes.coverMissPenalty = 8;
    }
  }

  if (intent.wantsLyrics && hasLyricsMarker) {
    score += 8;
    notes.lyricsBoost = 8;
  }

  if (intent.exactIntent) {
    score += anchor.hitCount * 7;
    notes.anchorHit = anchor.hitCount;
    if (!anchor.hasArtistAnchor) {
      score -= 24;
      notes.artistAnchorMissPenalty = 24;
    }
    if (anchor.hasArtistAnchor && anchor.hasTrackAnchor) {
      score += 26;
      notes.exactPairBoost = 26;
    } else if (anchor.hasArtistAnchor && !anchor.hasTrackAnchor) {
      score -= 16;
      notes.sameArtistWrongTrackPenalty = 16;
    }
    if (anchor.missingStrong > 0) {
      const penalty = anchor.missingStrong * 9;
      score -= penalty;
      notes.anchorMissPenalty = penalty;
    }
    if (anchor.hitCount <= 1) {
      score -= 20;
      notes.anchorWeakPenalty = 20;
    }
  }

  return { score, notes };
}

function queryWantsAlternateVersion(originalQuery) {
  const intent = parseSearchIntent(originalQuery);
  return (
    intent.wantsCover ||
    intent.wantsLyrics ||
    intent.wantsLive ||
    intent.wantsAlternateStyle ||
    /translation|karaoke|instrumental/i.test(String(originalQuery ?? '').toLowerCase())
  );
}

function queryDomainPenalty(titleBlob, originalQuery) {
  const q = String(originalQuery ?? '').toLowerCase();
  if (/\bkpop\b/.test(q) && !/\bkpop\b|hangul|한글|girlcrush|jyp|yg|sm\s+ent|hybe/i.test(titleBlob)) return -24;
  if (/\bjpop\b/.test(q) && !/\bjpop\b|anime|aimer|yoasobi|米津|utada|japanese/i.test(titleBlob)) return -18;
  if (/\bbach\b|cello suite|bwv|classical/i.test(q) && !/\bbach\b|bwv|suite|cello|pr[ée]lude|classical/i.test(titleBlob)) return -20;
  return 0;
}

/**
 * Этап 8: снять blanket за «категорию» alt-version; streak + junk отдельно.
 * Baseline-сравнение: `AUTOPLAY_ALT_VARIANTS_RELAXED=0`.
 */
export function isAutoplayAltVariantsRelaxed() {
  return String(process.env.AUTOPLAY_ALT_VARIANTS_RELAXED ?? '0').trim() === '1';
}

function nonTrackPenalty(titleBlob, originalQuery) {
  let p = 0;
  for (const h of NON_TRACK_HARD_HINTS) {
    if (titleBlob.includes(h)) p += 40;
  }
  const relaxed = isAutoplayAltVariantsRelaxed();
  if (!queryWantsAlternateVersion(originalQuery)) {
    const softList = relaxed ? NON_TRACK_SOFT_META_HINTS : NON_TRACK_SOFT_HINTS;
    for (const h of softList) {
      if (titleBlob.includes(h)) p += 16;
    }
  }
  if (relaxed) {
    for (const h of JUNK_LOW_EFFORT_HINTS) {
      if (titleBlob.includes(h)) p += 18;
    }
  }
  return p;
}

/**
 * Hard reject obvious non-track entries.
 * @param {Record<string, unknown>} video
 * @param {string} originalQuery
 */
function hardRejectNonTrackVideo(video, originalQuery) {
  const title = String(video?.title ?? '').toLowerCase();
  const desc = String(video?.description ?? '').slice(0, 240).toLowerCase();
  const blob = `${title} ${desc}`;
  if (hardRejectPlaylistTitle(title)) return true;
  const hardPenalty = NON_TRACK_HARD_HINTS.some((h) => blob.includes(h));
  if (hardPenalty) return true;
  if (!queryWantsAlternateVersion(originalQuery) && /full\s+album|playlist|mix\b|compilation/.test(blob)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Скоринг
// ---------------------------------------------------------------------------

/**
 * Выбирает видео с наибольшим шансом быть именно музыкой, а не эссе про аниме.
 * @param {unknown[]} results
 * @param {string} originalQuery
 */
function pickBestYoutubeSearchResult(results, originalQuery) {
  if (!results?.length) return null;
  const q = originalQuery.toLowerCase();
  const intent = parseSearchIntent(originalQuery);
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or',
    'из', 'с', 'со', 'в', 'на', 'по', 'для',
    'опенинг', 'опеннинг', 'opening',
    'включи', 'поставь', 'play', 'song', 'track', 'music',
  ]);
  const queryTokens = q
    .split(/[^a-zа-яё0-9]+/iu)
    .filter((w) => w.length > 2 && !stop.has(w));

  let best = results[0];
  let bestScore = -Infinity;

  for (const video of results) {
    const title = String(video?.title ?? '').toLowerCase();
    const channel = String(video?.channel?.name ?? video?.channel?.id ?? '').toLowerCase();
    const desc = String(video?.description ?? '')
      .slice(0, 240)
      .toLowerCase();
    const blob = `${title} ${channel} ${desc}`;
    let score = 0;

    for (const w of BAD_TITLE_HINTS) {
      if (blob.includes(w)) score -= 12;
    }
    for (const w of GOOD_TITLE_HINTS) {
      if (blob.includes(w)) score += 6;
    }

    const sec = Number(video?.durationInSec) || 0;
    if (!isAutoplayAltVariantsRelaxed() && video?.live && !intent.wantsLive) score -= 30;
    if (sec > 0) {
      if (sec < 20) score -= 6;
      else if (sec >= 45 && sec <= 420) score += 5;
      if (sec > 480) score -= 10;
      if (sec > 900) score -= 8;
    }

    for (const w of queryTokens) {
      if (title.includes(w)) score += 3;
    }
    score += queryDomainPenalty(blob, originalQuery);
    score -= nonTrackPenalty(blob, originalQuery);
    const anchor = anchorMetaForVideo(blob, channel, intent);
    const intentAdjust = scoreIntentAdjustments(blob, channel, Boolean(video?.live), intent, anchor);
    score += intentAdjust.score;

    if (score > bestScore) {
      bestScore = score;
      best = video;
    }
  }

  return best;
}

export function getAutoplayAltStreakMin() {
  const n = Number(process.env.AUTOPLAY_ALT_STREAK_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.min(6, Math.floor(n)) : 2;
}

function getAutoplayAltStreakPenalty() {
  const n = Number(process.env.AUTOPLAY_ALT_STREAK_PENALTY);
  return Number.isFinite(n) && n >= 0 ? Math.min(120, Math.floor(n)) : 38;
}

/**
 * Кавер / nightcore / slowed / edit и т.п. — для анти-спама подряд, не тотальный бан.
 * @param {string} title
 * @param {string} [channelName]
 */
export function isAlternateVariantTitle(title, channelName = '') {
  const blob = `${String(title ?? '')} ${String(channelName ?? '')}`.toLowerCase();
  if (!blob.trim()) return false;
  return (
    /\b(nightcore|night\s*core|slowed\s*\+\s*reverb|slowed\s*reverb|slowed|sped\s*up|spedup|speed\s*up|8d\s*audio|\b8d\b|bass\s*boosted|chipmunk|\bcover\b|кавер|gachi|vaporwave\s*edit|phonk\s*edit|fan\s*made|reverb\s*only|nightcore\s*mix)\b/i.test(
      blob,
    ) ||
    /(「\s*nightcore|【\s*nightcore|「\s*slowed|【\s*slowed)/i.test(blob)
  );
}

/**
 * Сколько подряд с конца сессии шли «альтернативные» треки (по заголовку).
 * @param {string[]} titles
 */
export function countTrailingAlternateStreak(titles) {
  const arr = Array.isArray(titles) ? titles : [];
  let streak = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = String(arr[i] ?? '');
    if (isAlternateVariantTitle(t)) streak += 1;
    else break;
  }
  return streak;
}

/** Жёсткий отсев квизов и мегаподборок (без скоринга). */
function hardRejectPlaylistTitle(title) {
  const s = String(title).toLowerCase();
  if (/угадай|угада|guess|quiz|квиз|challenge|try to guess|can you guess/i.test(s)) return true;
  if (/\b(20|25|30|40|50|60|70|80|90|100|150|200|300|500)\b.*(опенинг|opening|openings|аниме|anime)/i.test(s))
    return true;
  if (/(опенинг|opening|openings).*\b(20|25|30|40|50|60|70|80|90|100|150|200)\b/i.test(s))
    return true;
  if (/\d+\s+лучш|лучш(их|ие|ий)\s+\d+/i.test(s)) return true;
  if (/\bbest\s+\d+\b|\b\d+\s+best\b/i.test(s)) return true;
  if (/\btop\s*(10|15|20|25|30|40|50|100|150|200)\b/i.test(s)) return true;
  if (/\bтоп\s*(10|15|20|25|30|40|50|100|150|200)\b/i.test(s)) return true;
  if (/\btop\s+\d+\b/i.test(s)) return true;
  if (/most[\s-]?(looked|watched|popular)|all\s+time|of\s+all\s+time/i.test(s)) return true;
  if (
    /watches?:|watch(es)?\s+top|watch\s+party|react(s|ion)?\s+to|нарезк|реакц|смотрит|стинт|stint|highlight/i.test(
      s,
    )
  )
    return true;
  if (/лучших.*опен|best.*opening|greatest.*opening/i.test(s)) return true;
  if (/подряд|non-?stop|megamix|mega mix|marathon|\d+\s*час|hours of|compilation|компиляц|full\s+album/i.test(s))
    return true;
  if (/рабоч(ая|ей)\s+музык|working\s+music|study\s+music|background\s+music|music\s+for\s+work|concentration|productivity/i.test(s))
    return true;
  if (/\b1\s*час\b|\b\d+\s*hours?\b|\b\d+h\s+(of|mix|music)/i.test(s)) return true;
  if (/\bamv\b|「\s*amv|【\s*amv\s*】|anime\s+mix|anime\s+fights|best\s+anime\s+fight/i.test(s)) return true;
  if (/【\s*mad\s*】|「\s*mad\s*」|\[\s*mad\s*\]/i.test(s)) return true;
  if (/tutorial|туториал|teaches\s+you|how\s+to\s+make|учит\s+делать|make\s+a\s+beat/i.test(s)) return true;
  if (/\b(teaser|trailer|preview)\b|тизер|трейлер|превью|анонс\s*трейлер/i.test(s)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} video
 * @param {string} originalQuery
 * @param {{ alternateStreak?: number }} [scoreOpts]
 */
function scoreVideoForPlaylistDetailed(video, originalQuery, scoreOpts = {}) {
  const altVariantsRelaxed = isAutoplayAltVariantsRelaxed();
  const intent = parseSearchIntent(originalQuery);
  const title = String(video?.title ?? '').toLowerCase();
  const channel = String(video?.channel?.name ?? video?.channel?.id ?? '').toLowerCase();
  const desc = String(video?.description ?? '')
    .slice(0, 280)
    .toLowerCase();
  const blob = `${title} ${channel} ${desc}`;
  let score = 0;

  for (const w of BAD_TITLE_HINTS) {
    if (blob.includes(w)) score -= 14;
  }
  for (const w of PLAYLIST_EXTRA_BAD) {
    if (blob.includes(w)) score -= 22;
  }
  for (const w of GOOD_TITLE_HINTS) {
    if (blob.includes(w)) score += 7;
  }

  const sec = Number(video?.durationInSec) || 0;
  if (sec > 0) {
    if (sec >= 60 && sec <= 360) score += 14;
    else if (sec > 360 && sec <= 480) score += 4;
    if (sec > 420) score -= 12;
    if (sec > 540) score -= 40;
  }

  if (/\b(100|150|200|300|500)\b/.test(title)) score -= 22;
  if (/угадай|guess|quiz|квиз/i.test(title)) score -= 28;
  if (sec === 0) score -= 55;

  const q = originalQuery.toLowerCase();
  const words = q
    .split(/[^a-zа-яё0-9]+/iu)
    .filter((w) => w.length > 2);
  for (const w of words) {
    if (title.includes(w)) score += 2;
  }

  score += queryDomainPenalty(blob, originalQuery);
  const nonTrack = nonTrackPenalty(blob, originalQuery);
  score -= nonTrack;
  const anchor = anchorMetaForVideo(blob, channel, intent);
  const intentAdjust = scoreIntentAdjustments(blob, channel, Boolean(video?.live), intent, anchor);
  score += intentAdjust.score;

  const streak = Number(scoreOpts?.alternateStreak ?? 0) || 0;
  const minStreak = getAutoplayAltStreakMin();
  let alternateStreakPenalty = 0;
  let alternateStreakPenaltySteps = 0;
  if (
    streak >= minStreak &&
    !intent.wantsAlternateStyle &&
    !intent.wantsCover &&
    isAlternateVariantTitle(String(video?.title ?? ''), String(video?.channel?.name ?? ''))
  ) {
    if (altVariantsRelaxed) {
      alternateStreakPenaltySteps = streak - minStreak + 1;
      alternateStreakPenalty = getAutoplayAltStreakPenalty() * alternateStreakPenaltySteps;
    } else {
      alternateStreakPenaltySteps = 1;
      alternateStreakPenalty = getAutoplayAltStreakPenalty();
    }
    score -= alternateStreakPenalty;
  }

  return {
    score,
    debug: {
      searchScore: score,
      anchorHit: anchor.hitCount,
      nonTrackPenalty: nonTrack,
      intentAdjust: intentAdjust.notes,
      alternateStreakPenalty: alternateStreakPenalty || undefined,
      alternateStreak: streak || undefined,
      alternateStreakPenaltySteps: alternateStreakPenaltySteps || undefined,
      queryIntent: {
        official: intent.wantsOfficial,
        cover: intent.wantsCover,
        live: intent.wantsLive,
        lyrics: intent.wantsLyrics,
        alternateStyle: intent.wantsAlternateStyle,
        exact: intent.exactIntent,
        altVariantsRelaxed,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Низкоуровневый поиск
// ---------------------------------------------------------------------------

/**
 * Поиск через yt-dlp — fallback когда play-dl падает на новой разметке YouTube.
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<{ url: string, title: string, durationInSec: number, live: boolean, description: string }[]>}
 */
async function searchYoutubeVideosViaYtDlp(query, limit) {
  const safe = sanitizeYtSearchQuery(query);
  if (!safe) return [];
  const n = Math.min(Math.max(1, limit), 40);
  await acquireSearchSlot();
  try {
    const data = await youtubeDl(`ytsearch${n}:${safe}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      skipDownload: true,
      quiet: true,
      noWarnings: true,
      ignoreErrors: true,
      socketTimeout: 25,
      retries: 2,
      extractorRetries: 2,
    });
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const out = [];
    for (const e of entries) {
      const id = e?.id;
      if (id == null || String(id).startsWith('@')) continue;
      const webpage = e?.url || e?.webpage_url;
      const watchUrl =
        webpage && /^https?:\/\//i.test(String(webpage))
          ? String(webpage)
          : `https://www.youtube.com/watch?v=${id}`;
      const title = String(e?.title ?? '').trim() || 'Без названия';
      const dur = Number(e?.duration);
      const live =
        e?.live_status === 'is_live' ||
        e?.live_status === 'is_upcoming' ||
        e?.was_live === true;
      out.push({
        url: watchUrl,
        title,
        durationInSec: Number.isFinite(dur) && dur > 0 ? dur : 180,
        live: Boolean(live),
        description: '',
        // Normalised channel info so channelKey() works the same as with play-dl results
        channel: {
          id: String(e?.channel_id ?? e?.uploader_id ?? ''),
          name: String(e?.channel ?? e?.uploader ?? ''),
        },
      });
    }
    return out;
  } catch (e) {
    console.warn('[youtube-search] yt-dlp search', e instanceof Error ? e.message : e);
    return [];
  } finally {
    releaseSearchSlot();
  }
}

/**
 * Поиск видео для плейлиста/автоплея.
 * yt-dlp идёт первым — он стабильнее (play-dl периодически падает на browseId).
 * play-dl используется как запасной, если yt-dlp вернул пустой результат.
 * @param {string} query
 * @param {number} limit
 */
async function searchYoutubeVideosForPlaylist(query, limit) {
  const lim = Math.min(limit, 35);
  const ytdlpResults = await searchYoutubeVideosViaYtDlp(query, Math.min(lim, 25));
  if (ytdlpResults.length > 0) return ytdlpResults;
  // Fallback: play-dl (less stable but covers edge cases where yt-dlp fails)
  try {
    const batch = await play.search(query, { limit: lim, source: { youtube: 'video' } });
    if (Array.isArray(batch) && batch.length > 0) return batch;
  } catch (e) {
    console.warn('[youtube-search] play.search fallback', e instanceof Error ? e.message : e);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Публичное API
// ---------------------------------------------------------------------------

/**
 * Несколько разных роликов в духе отдельных треков (не часовые подборки).
 * @param {string} themeQuery
 * @param {number} count
 * @param {{ guildId?: string | null, alternateStreak?: number }} [opts]
 * @returns {Promise<{ title: string, url: string }[]>}
 */
export async function pickDistinctTrackVideos(themeQuery, count = 6, { guildId = null, alternateStreak = 0 } = {}) {
  const scoreOpts = { alternateStreak: Number(alternateStreak) || 0 };
  const theme = themeQuery.slice(0, 200).trim();
  if (!theme) throw new Error('Пустой запрос');
  const norm = normalizePlaylistTheme(theme);
  const queryIntent = parseSearchIntent(theme);
  const isAnime = /аниме|anime|опенинг|opening|\bop\b|эндинг|ending|\bed\b/i.test(norm);
  /**
   * Жанры где отдельные треки длиннее обычного (5-25 мин) и часовые стримы — норма.
   * Для них поднимаем потолок длины и подбираем субжанровые запросы.
   */
  const isLongForm = /ло[\s-]?фай|lo[\s-]?fi|lofi|chillhop|чиллхоп|\bambient\b|амбиент|джаз|jazz/i.test(norm);

  /** Fallback-запросы — используются если Groq недоступен или вернул ошибку. */
  let fallbackQueries;
  if (isLongForm) {
    fallbackQueries = [
      `${norm} hip hop beats song`,
      `${norm} chill music track`,
      `${norm} bedroom pop song`,
      `${norm} aesthetic music`,
      `${norm} original song`,
    ];
  } else {
    fallbackQueries = [
      buildPlaylistSearchQuery(theme),
      `${norm} lyrics`,
      isAnime ? `${norm} full song` : `${norm} music video`,
      isAnime ? `${norm} theme song` : `${norm} official`,
      `${norm} audio`,
    ];
  }

  const queries = fallbackQueries;

  /**
   * Все запросы параллельно — время поиска = время самого медленного вместо суммы.
   * С каждого берём не более SLOT кандидатов, чтобы ни один запрос не доминировал.
   */
  const SLOT = 5;
  const batches = await Promise.all(queries.map((q) => searchYoutubeVideosForPlaylist(q, 20).catch(() => [])));
  const seenUrl = new Set();
  /** @type {unknown[]} */
  const merged = [];
  for (const batch of batches) {
    if (!batch?.length) continue;
    let taken = 0;
    for (const v of batch) {
      if (taken >= SLOT) break;
      const u = v?.url;
      if (u && !seenUrl.has(u)) {
        seenUrl.add(u);
        merged.push(v);
        taken++;
      }
    }
  }
  if (!merged.length) throw new Error('Ничего не найдено');

  /**
   * Потолок длины: для lo-fi/ambient/jazz — до 25 минут (там трек и 10-15 мин норма),
   * для всего остального — до 7 минут (стандартный трек/опенинг).
   */
  const MAX_SEC = isLongForm ? 1500 : 420;

  const ranked = [];
  for (const video of merged) {
    const url = video?.url;
    if (!url) continue;
    if (video.live) continue;
    const title = String(video?.title ?? '');
    if (hardRejectPlaylistTitle(title)) continue;
    if (hardRejectNonTrackVideo(video, themeQuery)) continue;

    const sec = Number(video.durationInSec);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    if (sec < 30 || sec > MAX_SEC) continue;

    const { score, debug } = scoreVideoForPlaylistDetailed(video, themeQuery, scoreOpts);
    if (score < -55) continue;
    ranked.push({ video, score, debug });
  }
  ranked.sort((a, b) => b.score - a.score);

  /**
   * Выбор: весь пул перемешиваем случайно (Fisher-Yates), затем берём первые count.
   * Гарантированных «топ» пиков нет — скоринг уже отфильтровал мусор.
   * Дополнительно: не более 2 треков с одного YouTube-канала.
   */
  const POOL_SIZE = Math.min(ranked.length, 20);
  const pool = ranked.slice(0, POOL_SIZE);

  // Exact/official flows must prefer the best-ranked canonical candidates.
  if (!(queryIntent.exactIntent || queryIntent.wantsOfficial)) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  const out = [];
  const seenFinal = new Set();
  /** @type {Map<string, number>} */
  const channelHits = new Map();

  /** @param {unknown} video */
  function channelKey(video) {
    return String(video?.channel?.id ?? video?.channel?.name ?? '');
  }

  function tryAdd(video, debugMeta = null) {
    const url = video.url;
    if (seenFinal.has(url)) return false;
    const ch = channelKey(video);
    if (ch && (channelHits.get(ch) ?? 0) >= 2) return false;
    seenFinal.add(url);
    if (ch) channelHits.set(ch, (channelHits.get(ch) ?? 0) + 1);
    const item = { title: String(video.title || '').trim() || 'Без названия', url };
    if (debugMeta) item._debug = debugMeta;
    out.push(item);
    return true;
  }

  for (const { video, debug } of pool) {
    if (out.length >= count) break;
    tryAdd(video, debug);
  }

  if (out.length === 0) {
    const fallbackQueries = isLongForm
      ? [`${norm} chill track`, `${norm} instrumental track`, `${norm} lofi song`]
      : [`${norm} official audio`, `${norm} song`, `${norm} music video`];
    const fallbackBatches = await Promise.all(
      fallbackQueries.map((q) => searchYoutubeVideosForPlaylist(q, 14).catch(() => [])),
    );
    const fallbackSeen = new Set();
    /** @type {{ video: Record<string, unknown>, score: number, debug: Record<string, unknown> }[]} */
    const fallbackRanked = [];
    for (const batch of fallbackBatches) {
      for (const video of batch) {
        const url = String(video?.url ?? '');
        if (!url || fallbackSeen.has(url)) continue;
        fallbackSeen.add(url);
        if (hardRejectNonTrackVideo(video, themeQuery)) continue;
        const sec = Number(video?.durationInSec);
        const relaxedMax = isLongForm ? 2100 : 660;
        if (!Number.isFinite(sec) || sec < 20 || sec > relaxedMax) continue;
        const { score, debug } = scoreVideoForPlaylistDetailed(video, themeQuery, scoreOpts);
        if (score < -95) continue;
        fallbackRanked.push({ video, score, debug: { ...debug, singleTrackFallback: true } });
      }
    }
    fallbackRanked.sort((a, b) => b.score - a.score);
    for (const row of fallbackRanked.slice(0, Math.max(count * 2, 6))) {
      if (out.length >= count) break;
      tryAdd(row.video, row.debug);
    }
    if (out.length > 0 && isAutoplayDebugEnabled()) {
      console.log(`[youtube-search:debug] fallback-used guild=${guildId ?? 'n/a'} query="${themeQuery}" count=${out.length}`);
    }
  }

  if (out.length === 0) {
    // Pass-2 fallback: keep single-track bias, but relax score gate and duration to avoid hard empty.
    const pass2 = [];
    const seen = new Set();
    for (const video of merged) {
      const url = String(video?.url ?? '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(video?.title ?? '');
      if (hardRejectPlaylistTitle(title)) continue;
      const sec = Number(video?.durationInSec);
      const maxSec = isLongForm ? 3000 : 900;
      if (!Number.isFinite(sec) || sec < 20 || sec > maxSec) continue;
      const { score, debug } = scoreVideoForPlaylistDetailed(video, themeQuery, scoreOpts);
      if (score < -125) continue;
      pass2.push({ video, score, debug: { ...debug, singleTrackFallback: true, pass2Relaxed: true } });
    }
    pass2.sort((a, b) => b.score - a.score);
    for (const row of pass2.slice(0, Math.max(count * 2, 8))) {
      if (out.length >= count) break;
      tryAdd(row.video, row.debug);
    }
    if (out.length > 0 && isAutoplayDebugEnabled()) {
      console.log(`[youtube-search:debug] fallback-pass2-used guild=${guildId ?? 'n/a'} query="${themeQuery}" count=${out.length}`);
    }
  }

  if (out.length === 0) {
    throw new Error(
      'Не нашёл отдельных треков (слишком много длинных подборок в выдаче). Сформулируй конкретнее: название трека, группа или «название аниме opening».',
    );
  }

  /** Local boost: перевзвешивает по истории сигналов гильдии (fail-open). */
  if (guildId && isBridgeEnabled()) {
    return applyLocalBoost(guildId, out);
  }
  return out;
}

/**
 * Artist-first helper for autoplay: expands one artist into a small pool
 * of likely canonical tracks, then applies the same filtering/ranking stack.
 *
 * @param {string} artistName
 * @param {number} count
 * @param {{ guildId?: string | null, alternateStreak?: number }} [opts]
 * @returns {Promise<{ title: string, url: string }[]>}
 */
export async function pickTracksForArtist(artistName, count = 6, { guildId = null, alternateStreak = 0 } = {}) {
  const artist = String(artistName ?? '').trim().replace(/\s+/g, ' ');
  if (!artist) return [];
  const queries = [
    `${artist} official audio`,
    `${artist} top track official`,
    `${artist} song`,
  ];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const batch = await pickDistinctTrackVideos(q, Math.max(3, count), {
      guildId,
      alternateStreak,
    }).catch(() => []);
    for (const item of batch) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= count) return out;
    }
  }
  return out.slice(0, count);
}

/**
 * Поисковый запрос → watch URL + отображаемый заголовок.
 * @param {string} query
 * @returns {Promise<{ url: string, label: string }>}
 */
export async function resolveYoutubeFromQuery(query) {
  const trimmed = String(query).trim();
  const norm = tryNormalizeYoutubeUrl(trimmed);
  if (norm && play.yt_validate(norm) === 'video') {
    const label = await resolveYoutubeCanonicalTitle(norm, norm);
    return { url: norm, label };
  }
  const q = augmentYoutubeSearchQuery(query);
  // yt-dlp first — more stable than play-dl's browseId-based lookup
  let searched = await searchYoutubeVideosViaYtDlp(q, 10);
  if (!searched.length) {
    try {
      const batch = await play.search(q, { limit: 15, source: { youtube: 'video' } });
      if (Array.isArray(batch) && batch.length > 0) searched = batch;
    } catch (e) {
      console.warn('[youtube-search] play.search (resolve fallback)', e instanceof Error ? e.message : e);
    }
  }
  const picked = pickBestYoutubeSearchResult(searched, query);
  if (!picked?.url) throw new Error('Ничего не найдено');
  return { url: picked.url, label: picked.title || query };
}

/**
 * Для watch URL YouTube — заголовок ролика; иначе исходная строка (поисковый запрос и т.д.).
 * @param {string} queryOrUrl
 */
export async function resolveYoutubeDisplayLabel(queryOrUrl) {
  const raw = String(queryOrUrl).trim();
  if (!raw) return raw;
  const norm = tryNormalizeYoutubeUrl(raw);
  const target = norm ?? raw;
  if (play.yt_validate(target) === 'video') {
    try {
      const info = await play.video_basic_info(target);
      const t = info.video_details?.title;
      if (t && String(t).trim()) return String(t).trim();
    } catch (e) {
      console.warn('[youtube-search] video_basic_info', e);
    }
  }
  return raw;
}

/**
 * Один источник правды для подписи трека в UI и панели: метаданные ролика (video_basic_info),
 * а не заголовок из строки выдачи поиска — они часто расходятся.
 * @param {string} watchUrl
 * @param {string} [fallback] — например title из resolveYoutubeFromQuery, если метаданные недоступны
 */
export async function resolveYoutubeCanonicalTitle(watchUrl, fallback = '') {
  const t = await resolveYoutubeDisplayLabel(watchUrl);
  const s = String(t ?? '').trim();
  if (s && !/^https?:\/\//i.test(s)) return s;
  return fallback ? String(fallback).trim() : s;
}

/**
 * Builds 2–3 YouTube search strings from a structured autoplay recommendation.
 *
 * **Blend schema (preferred):** abstract axes + merge_strategy — see groq.js TrackBlendStruct.
 * **Legacy flat:** `{ genre, mood, style }` without nested axes (fallback / old responses).
 *
 * @param {Record<string, unknown>} struct
 * @returns {string[]}
 */
export function buildSearchQueriesFromStruct(struct = {}) {
  const squeeze = (parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const s = struct;
  if (s?.session_anchor && typeof s.session_anchor === 'object') {
    return buildSearchQueriesFromBlendStruct(s);
  }
  /** @type {{ genre?: string, mood?: string, style?: string }} */
  const flat = s;
  const g = normalizeAxisPhrase(flat.axis_primary ?? flat.genre ?? '');
  const m = normalizeAxisPhrase(flat.axis_secondary ?? flat.mood ?? '');
  const st = normalizeAxisPhrase(flat.texture ?? flat.style ?? '');
  if (!g && !m) return [];
  const base = squeeze([g, m]);
  const queries = [squeeze([base, 'official audio']), squeeze([base, 'full song'])];
  if (st && st !== g && st !== m) queries.push(squeeze([g || m, st, 'official audio']));
  return sanitizeBuiltQueries(queries).slice(0, 3);
}

/**
 * Deterministic queries from abstract axes + merge_strategy (variant 1 — explicit blend).
 *
 * @param {{
 *   session_anchor: { axis_primary?: string, axis_secondary?: string, genre?: string, mood?: string },
 *   primary_focus: { axis_primary?: string, axis_secondary?: string, genre?: string, mood?: string },
 *   texture?: string,
 *   style?: string,
 *   merge_strategy?: 'bridge' | 'favor_anchor' | 'favor_momentum',
 * }} blend
 * @returns {string[]}
 */
function buildSearchQueriesFromBlendStruct(blend) {
  const ag = normalizeAxisPhrase(blend.session_anchor?.axis_primary ?? blend.session_anchor?.genre ?? '');
  const am = normalizeAxisPhrase(blend.session_anchor?.axis_secondary ?? blend.session_anchor?.mood ?? '');
  const pg = normalizeAxisPhrase(blend.primary_focus?.axis_primary ?? blend.primary_focus?.genre ?? '');
  const pm = normalizeAxisPhrase(blend.primary_focus?.axis_secondary ?? blend.primary_focus?.mood ?? '');
  const style = normalizeAxisPhrase(blend.texture ?? blend.style ?? '');
  const seedClass = String(blend.seed_class ?? '').toLowerCase().trim();
  const identityAnchor =
    seedClass === 'identity' ? normalizeIdentityPhrase(blend.identity_anchor ?? '') : '';
  const strategy = blend.merge_strategy === 'favor_anchor' || blend.merge_strategy === 'favor_momentum'
    ? blend.merge_strategy
    : 'bridge';

  const squeeze = (parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  /** @type {string[]} */
  const out = [];

  if (strategy === 'favor_anchor') {
    if (identityAnchor && (ag || am || pg || pm)) {
      out.push(squeeze([identityAnchor, ag || pg, 'official audio']));
    }
    if (ag || am) out.push(squeeze([ag || am, am || style, 'official audio']));
    if (pg || pm) out.push(squeeze([pg || pm, ag || am, 'official audio']));
    if (style && (ag || pg)) out.push(squeeze([ag || pg, style, 'official audio']));
  } else if (strategy === 'favor_momentum') {
    if (identityAnchor && (pg || pm || ag || am)) {
      out.push(squeeze([identityAnchor, pg || ag, 'official audio']));
    }
    if (pg || pm) out.push(squeeze([pg || pm, pm || style, 'official audio']));
    if (ag || am) out.push(squeeze([ag || am, pg || pm, 'official audio']));
    if (style && (pg || ag)) out.push(squeeze([pg || ag, style, 'official audio']));
  } else {
    // bridge: cross terms so YouTube can find "in-between" results
    if (identityAnchor && (pg || ag || pm || am)) {
      out.push(squeeze([identityAnchor, pg || ag, 'official audio']));
    }
    if (ag && pm) out.push(squeeze([ag, pm, 'official audio']));
    if (pg && am) out.push(squeeze([pg, am, 'official audio']));
    if ((ag || pg) && style) out.push(squeeze([ag || pg, style, 'official audio']));
  }

  const uniq = [...new Set(out.map((q) => q.replace(/\s+/g, ' ').trim()))];
  const filtered = sanitizeBuiltQueries(uniq).slice(0, 3);
  if (filtered.length > 0) return filtered;
  const fallback = squeeze([identityAnchor || '', ag || pg, am || pm, 'official audio']);
  return sanitizeBuiltQueries([fallback]).slice(0, 1);
}

const AXIS_NOISE_TOKENS = new Set([
  'axis', 'primary', 'secondary', 'descriptor', 'style', 'genre', 'mood', 'vibe',
  'energy', 'intensity', 'era', 'official', 'audio', 'song', 'track', 'music',
  'substyle', 'tempo', 'continuity', 'novelty', 'focus',
]);

function normalizeAxisPhrase(raw) {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[:_]/g, ' ')
    .replace(/\b(?:axis|style|genre|mood|vibe|energy|intensity|era|substyle)\b\s+/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const toks = cleaned
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !AXIS_NOISE_TOKENS.has(w))
    .slice(0, 2);
  return toks.join(' ');
}

function normalizeIdentityPhrase(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[:_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const toks = cleaned
    .split(/[\s-]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  return toks.join(' ');
}

function isUsableBuiltQuery(q) {
  const s = String(q ?? '').toLowerCase().trim();
  if (!s || s.length < 8) return false;
  const core = s
    .replace(/\bofficial\b/g, ' ')
    .replace(/\baudio\b/g, ' ')
    .replace(/\bfull\b/g, ' ')
    .replace(/\bsong\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = core.split(/[\s-]+/).filter((w) => w.length >= 3);
  return tokens.length >= 2;
}

function sanitizeBuiltQueries(queries) {
  return (Array.isArray(queries) ? queries : [])
    .map((q) => String(q).replace(/\s+/g, ' ').trim())
    .filter((q, idx, arr) => q && arr.indexOf(q) === idx)
    .filter((q) => isUsableBuiltQuery(q));
}

/**
 * Strips YouTube-specific noise from a track title before sending to an LLM.
 *
 * Removes: "(Official Music Video)", "♂…♂", "【MAD】", "[Right Version]",
 * "| Channel Name" suffixes and similar clutter that pollutes music context.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitleForContext(title) {
  let s = String(title);

  // Gachi / right-version markers: ♂ text ♂
  s = s.replace(/♂[^♂]*♂/g, '');

  // CJK fullwidth bracket blocks: 【…】 「…」
  s = s.replace(/【[^】]*】/g, '').replace(/「[^」]*」/g, '');

  // Square brackets with known YouTube/fandom noise keywords
  s = s.replace(/\[[^\]]*(?:right\s*ver(?:sion)?|amv|mad|hd|hq|official|full\s*ver|remix|remaster(?:ed)?)[^\]]*\]/gi, '');

  // Round brackets with common upload-metadata noise
  s = s.replace(
    /\(\s*(?:official\s+(?:music\s+)?(?:video|audio|upload)|lyric(?:s)?\s+video|full\s+(?:song|version|mv)|hd|hq|audio|video|remaster(?:ed)?|official)\s*\)/gi,
    '',
  );

  // "| Channel Name" or "// Channel" trailing suffix
  s = s.replace(/\s*[|\/]{1,2}\s*.{2,40}$/, '');

  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Lightweight single-query search intended for the fast prefetch phase.
 * Runs exactly ONE yt-dlp search process (+ play-dl fallback if yt-dlp fails).
 * No fanout, no parallel queries — cheap by design.
 * Goes through the search semaphore just like all other yt-dlp searches.
 *
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<{ url: string, title: string, durationInSec: number, live: boolean, channel: object }>>}
 */
export async function searchOnceForPrefetch(query, limit = 8) {
  return searchYoutubeVideosForPlaylist(query, Math.min(limit, 15));
}
