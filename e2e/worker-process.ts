import { spawn } from 'node:child_process';
import { openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot, stackEnv, WORKER_METRICS_PORT } from './stack';

/**
 * Процесс фоновых задач для стенда.
 *
 * Поднимается отдельно от webServer'ов Playwright: у воркера нет HTTP-порта, а
 * webServer умеет ждать только адрес. Без него не закрываются торги — finisher
 * живёт именно здесь, — и «модалка завершения у всех клиентов» не наступит
 * никогда.
 */

const PID_FILE = resolve(repoRoot(), 'e2e', '.worker.pid');

export default function startWorker(): void {
  // Вывод в файл, а не в никуда: упавший воркер иначе выглядит как «ставки не
  // доезжают в базу», и причину приходится искать в трёх других местах.
  const log = openSync(resolve(repoRoot(), 'e2e', '.worker.log'), 'w');
  const child = spawn('node', ['dist/main.worker.js'], {
    cwd: resolve(repoRoot(), 'apps/api'),
    env: { ...process.env, ...stackEnv(), METRICS_PORT: String(WORKER_METRICS_PORT) },
    stdio: ['ignore', log, log],
    detached: false,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid ?? ''), 'utf8');
}

export function stopWorker(): void {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid);
    }
  } catch {
    // Процесс мог уже умереть вместе с прогоном — это не повод падать.
  } finally {
    rmSync(PID_FILE, { force: true });
  }
}
