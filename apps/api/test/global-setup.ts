import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { Client } from 'pg';

import { findRepoRoot, resolveTestUrls, TEST_DB_NAME } from './test-db';

/**
 * Готовит базу для e2e: создаёт, если её нет, и накатывает миграции.
 *
 * Именно миграциями, а не `db push`: тесты обязаны идти по той же схеме, что
 * поедет в прод. Иначе зелёный e2e ничего не говорит о боевой БД.
 */
export async function setup(): Promise<void> {
  const { databaseUrl, adminUrl } = resolveTestUrls();
  const root = findRepoRoot(process.cwd());
  const apiDir = resolve(root, 'apps/api');

  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    const existing = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_database WHERE datname = $1',
      [TEST_DB_NAME],
    );
    if (existing.rows[0]?.count === '0') {
      // Имя проверено в resolveTestUrls, интерполяция безопасна:
      // идентификаторы в CREATE DATABASE параметрами не передаются.
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
      console.log(`[e2e] создана база ${TEST_DB_NAME}`);
    }
  } finally {
    await admin.end();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
  });
  console.log(`[e2e] миграции применены к ${TEST_DB_NAME}`);
}
