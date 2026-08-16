import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { Client } from 'pg';

import { repoRoot, stackEnv, TEST_DB_NAME, testDatabaseUrl } from './stack';

/**
 * Подготовка стенда: база, миграции, сборка.
 *
 * Отдельным шагом ПЕРЕД playwright, а не его globalSetup: Playwright поднимает
 * серверы раньше, чем зовёт globalSetup, и собранного кода к их старту ещё бы
 * не существовало.
 *
 * Собираем и запускаем `dist`, а не `nest start`: два процесса в watch-режиме
 * компилируют один и тот же код дважды и стартуют минуту. Плюс так стенд ближе
 * к прод-контуру, где в контейнере лежит собранный код.
 */
async function prepare(): Promise<void> {
  const root = repoRoot();
  const apiDir = resolve(root, 'apps/api');
  const databaseUrl = testDatabaseUrl();
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';

  const admin = new Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    const existing = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_database WHERE datname = $1',
      [TEST_DB_NAME],
    );
    if (existing.rows[0]?.count === '0') {
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    }
  } finally {
    await admin.end();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, ...stackEnv() },
  });

  // Сборка воркспейса целиком: shared собирается первым, иначе api не соберётся.
  // NODE_ENV=production обязателен для сборки web: Next инлайнит настройки в
  // клиентский бандл на этом шаге, и собранное с другим значением приложение
  // потом не запускается как продовое.
  execFileSync('pnpm', ['-r', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, ...stackEnv(), NODE_ENV: 'production' },
  });
  console.log(`[e2e] стенд собран, база ${TEST_DB_NAME} готова`);
}

// Не top-level await: пакет собирается как CommonJS, и такой await не
// транспилируется. Ошибка обязана валить прогон — стенд без базы и без
// собранного кода не поднимется, и разбираться в этом посреди теста незачем.
prepare().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
