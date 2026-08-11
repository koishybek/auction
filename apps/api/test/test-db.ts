import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Отдельная база для e2e. Прогон тестов чистит таблицы, поэтому запускать их
 * на dev-базе нельзя — данные разработчика исчезнут без предупреждения.
 */
export const TEST_DB_NAME = 'auction_test';

/**
 * Хранилище файлов для e2e — во временном каталоге ОС, а не в рабочем дереве:
 * тесты не должны оставлять мусор в репозитории.
 */
export const TEST_STORAGE_ROOT = resolve(tmpdir(), 'auction-e2e-storage');

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
 * Единая очистка данных между тестами.
 *
 * Порядок продиктован внешними ключами: сначала дети, потом родители.
 * Живёт в одном месте, чтобы каждый e2e-файл не изобретал свой список и не
 * ронял соседний файл забытой таблицей (lots_seller_id_fkey тому свидетель).
 *
 * bids и audit_log здесь НЕТ намеренно: они append-only, удаление запрещено
 * триггером БД. Тесты, создающие ставки, обязаны работать на уникальных
 * пользователях и лотах, а не рассчитывать на глобальную зачистку.
 */
export async function cleanDatabase(prisma: PrismaService): Promise<void> {
  await prisma.registryCheck.deleteMany();
  await prisma.openHouseBooking.deleteMany();
  await prisma.openHouseSlot.deleteMany();
  await prisma.lotDocument.deleteMany();
  await prisma.refBonus.deleteMany();
  await prisma.payoutSplit.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.deposit.deleteMany();
  await prisma.auctionSession.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.partnerLead.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.authSession.deleteMany();
  await prisma.user.deleteMany();
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
