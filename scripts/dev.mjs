/**
 * Разработка: все процессы разом.
 *
 *   pnpm dev
 *
 * Раньше эта команда поднимала API и web — но не WS-gateway и не воркер. Итог:
 * каталог работает, карточка лота открывается, а торги мертвы. Кнопка ставки
 * жмётся, сокет стучится в никуда, таймер не идёт, лот не закрывается по
 * тишине. Выглядит как сломанный продукт, а на деле не запущены два процесса
 * из трёх — и об этом нигде не сказано.
 *
 * Здесь запускаются все четыре: API, gateway, воркер, web. Каждый в своём
 * watch-режиме, как и раньше.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROCESSES = [
  { name: 'api', cwd: 'apps/api', script: 'dev' },
  { name: 'gateway', cwd: 'apps/api', script: 'dev:gateway' },
  { name: 'worker', cwd: 'apps/api', script: 'dev:worker' },
  { name: 'web', cwd: 'apps/web', script: 'dev' },
];

const children = [];

for (const { name, cwd, script } of PROCESSES) {
  const child = spawn('pnpm', ['run', script], {
    cwd: resolve(ROOT, cwd),
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${name} завершился с кодом ${String(code)}`);
    }
  });
  children.push(child);
}

function stopAll() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* уже мёртв */
    }
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
