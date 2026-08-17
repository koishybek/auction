import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Адреса и окружение стенда для браузерных тестов.
 *
 * Стенд поднимается СВОЙ, на своих портах и на тестовой базе. Гонять приёмку
 * по базе разработчика нельзя: тесты создают лоты и доводят их до торгов, а
 * ставки и аудит удалить невозможно — append-only включён на уровне БД.
 */

/** Порты намеренно не совпадают с dev: стенд не должен драться с запущенным `pnpm dev`. */
export const API_PORT = 3110;
export const GATEWAY_PORT = 3210;
export const WEB_PORT = 3111;

export const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
export const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;

export const TEST_DB_NAME = 'auction_test';

/**
 * Корень воркспейса — поиском вверх от текущего каталога.
 *
 * Не через `import.meta` и не через `__dirname`: Playwright исполняет
 * конфигурацию как CommonJS, а типы в пакете собираются как ESM, и любой из
 * двух способов ломается на одной из сторон.
 */
export function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Строка подключения к тестовой базе — то же имя, что у vitest-прогона. */
export function testDatabaseUrl(): string {
  const root = repoRoot();
  // Node сам читает .env: отдельной зависимости ради трёх строк не нужно.
  //
  // Отсутствие файла — не ошибка: в CI переменные приходят из окружения job'а,
  // и .env там нет вовсе. Падать на этом значило бы запретить прогон в CI ради
  // удобства локального запуска.
  try {
    process.loadEnvFile(resolve(root, '.env'));
  } catch {
    // Значения проверяются ниже — по факту наличия, а не по источнику.
  }

  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw === '') {
    throw new Error('DATABASE_URL не задан — см. docs/dev-setup.md');
  }
  const url = new URL(raw);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

/**
 * Окружение процессов стенда.
 *
 * Пространство имён в Redis своё: браузерный прогон и vitest-прогон ходят в
 * один инстанс, и общий префикс означал бы, что один прогон вычищает ключи
 * другого.
 */
export function stackEnv(): Record<string, string> {
  const databaseUrl = testDatabaseUrl();
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    REDIS_NAMESPACE: 'auction-e2e-web',
    API_PORT: String(API_PORT),
    GATEWAY_PORT: String(GATEWAY_PORT),
    API_BASE_URL: API_URL,
    // Фоновый сброс просмотров за спиной теста уносил бы накопленное в БД
    // посреди проверки.
    LOT_VIEWS_FLUSH_MS: '3600000',
  };
}
