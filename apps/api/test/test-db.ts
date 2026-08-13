import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { RedisService } from '../src/redis/redis.service';

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

  /**
   * Всё, на что ссылаются ставки, переживает очистку.
   *
   * Это не послабление, а прямое следствие append-only: строку ставки удалить
   * нельзя ничем, включая ручной psql, поэтому её сессия, лот и участник не
   * могут исчезнуть — внешние ключи не позволят. Пытаться их снести значит
   * ронять очистку сразу после первого же теста, который дошёл до торгов.
   *
   * Остатки безвредны: тесты работают на уникальных ИИН и VIN, а полное
   * обнуление, если оно однажды понадобится, делается пересозданием схемы
   * (`pnpm db:reset`), которое append-only-триггеры не блокируют.
   */
  /**
   * Ставки и аудит удаляются только здесь и только потому, что база
   * оканчивается на `_test`: единственное исключение из append-only записано
   * в самой функции триггера (миграция append_only_test_db_escape).
   *
   * Без него очистка невозможна в принципе: на ставку по внешним ключам висят
   * сессия, лот и участник, а значит неудаляемы и они. После первого же теста,
   * дошедшего до торгов, соседние тесты видели бы чужие лоты в каталоге и
   * чужих людей в списке пользователей.
   */
  await prisma.bid.deleteMany();
  await prisma.auctionSession.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.partnerLead.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.authSession.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Убрать ключи прогона из Redis.
 *
 * Только своё пространство имён и только через SCAN: FLUSHDB снёс бы всё, что
 * есть в инстансе, а разработка и тесты ходят в один и тот же Redis. SCAN не
 * блокирует сервер, в отличие от KEYS.
 */
export async function cleanRedis(redis: RedisService): Promise<void> {
  const pattern = `${redis.key()}:*`;
  let cursor = '0';
  do {
    const [next, keys] = await redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    if (keys.length > 0) {
      await redis.client.del(...keys);
    }
    cursor = next;
  } while (cursor !== '0');
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
