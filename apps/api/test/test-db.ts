import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';

/**
 * Отдельная база для e2e. Прогон тестов чистит таблицы, поэтому запускать их
 * на dev-базе нельзя — данные разработчика исчезнут без предупреждения.
 */
export const TEST_DB_NAME = 'auction_test';

export function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Подменяет имя базы в строке подключения, остальное оставляя как есть. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export function databaseNameOf(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, '');
}

/**
 * Строки подключения для тестов.
 *
 * Бросает, если имя базы не заканчивается на `_test`: это последний рубеж перед
 * тем, как прогон тестов вычистит чужие данные.
 */
export function resolveTestUrls(): { databaseUrl: string; adminUrl: string } {
  const root = findRepoRoot(process.cwd());
  loadEnv({ path: resolve(root, '.env') });

  const base = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];
  if (base === undefined || base === '') {
    throw new Error('Не задан DIRECT_URL/DATABASE_URL — нечего подменять для тестовой базы');
  }

  const databaseUrl = withDatabase(base, TEST_DB_NAME);
  const name = databaseNameOf(databaseUrl);
  if (!name.endsWith('_test')) {
    throw new Error(
      `Тестовая база обязана оканчиваться на _test, получено «${name}». Прогон остановлен.`,
    );
  }

  return { databaseUrl, adminUrl: withDatabase(base, 'postgres') };
}
