import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOCK_NAME = '.bot-single.lock';
/** Корень проекта (папка `bot/`), не process.cwd() — иначе lock размножается. */
const BOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function lockPath() {
  return path.join(BOT_ROOT, LOCK_NAME);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Один процесс на папку: второй экземпляр сразу выходит.
 * Иначе два бота с одним токеном по очереди ловят slash — отсюда «то войс, то ссылки».
 */
export function ensureSingleBotProcess() {
  const file = lockPath();

  const release = () => {
    try {
      const txt = fs.readFileSync(file, 'utf8').trim();
      if (txt === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.on('exit', release);
      process.once('SIGINT', () => {
        release();
        process.exit(0);
      });
      process.once('SIGTERM', () => {
        release();
        process.exit(0);
      });
      return;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') {
        console.warn('[single-instance] lock:', e);
        return;
      }
      try {
        const oldPid = Number(fs.readFileSync(file, 'utf8').trim());
        if (isPidAlive(oldPid)) {
          console.error(
            `[single-instance] Уже запущен другой бот (PID ${oldPid}). Закрой тот процесс — иначе команды будут то старые, то новые.`,
          );
          process.exit(1);
        }
        fs.unlinkSync(file);
      } catch {
        /* снова попробуем создать lock */
      }
    }
  }
}
