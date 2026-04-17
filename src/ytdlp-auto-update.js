import { update as updateYtDlp } from 'youtube-dl-exec';

/**
 * Фоновые проверки обновления бинарника yt-dlp (youtube-dl-exec качает его в postinstall).
 * Первый запуск — через несколько секунд после готовности бота, далее по интервалу.
 */
export function startYtDlpAutoUpdate() {
  const raw = String(process.env.YT_DLP_AUTO_UPDATE ?? '1').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return;

  const hours = Number.parseFloat(process.env.YT_DLP_UPDATE_INTERVAL_HOURS ?? '24');
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;

  const delayMs = Number.parseInt(String(process.env.YT_DLP_UPDATE_DELAY_MS ?? '8000'), 10);
  const firstDelay =
    Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 8_000;

  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const child = await updateYtDlp();
      const out =
        typeof child?.stdout === 'string' ? child.stdout.trim() : '';
      if (out) {
        const tail = out.split(/\r?\n/).filter(Boolean).slice(-2).join(' · ');
        console.log('[ytdlp]', tail || out.slice(0, 200));
      } else {
        console.log('[ytdlp] проверка обновления выполнена');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[ytdlp] автообновление:', msg.split('\n')[0].slice(0, 220));
    } finally {
      busy = false;
    }
  }

  setTimeout(() => void tick(), firstDelay);
  setInterval(() => void tick(), intervalMs);
}
