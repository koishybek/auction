import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { BlindIdService } from '../src/auction/blind-id.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Blind ID (T-029, FR-09).
 *
 * DoD: пять тысяч участников одного лота и ни одной коллизии. Смысл механизма
 * не в красоте: совпавшие или узнаваемые между лотами номера позволяют
 * участникам договориться не перебивать друг друга.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let blindIds: BlindIdService;

/** Лот и участники создаются напрямую: пять тысяч человек через HTTP не завести. */
async function seedLot(): Promise<string> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: 100_000_000n,
    },
    select: { id: true },
  });
  return lot.id;
}

async function seedUsers(count: number): Promise<string[]> {
  await prisma.user.createMany({
    data: Array.from({ length: count }, () => ({ roles: ['INVESTOR' as const] })),
  });
  const users = await prisma.user.findMany({
    where: { roles: { has: 'INVESTOR' } },
    select: { id: true },
    take: count,
  });
  return users.map((user) => user.id);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  blindIds = app.get(BlindIdService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-029: Blind ID', () => {
  it('DoD: 5000 участников одного лота — ни одной коллизии', async () => {
    const lotId = await seedLot();
    const users = await seedUsers(5_000);
    expect(users).toHaveLength(5_000);

    const codes: string[] = [];
    for (const userId of users) {
      codes.push(await blindIds.codeFor(lotId, userId));
    }

    // Уникальность гарантирует не подбор, а ключ в БД: даже если бы подбор
    // ошибся, вставка бы не прошла.
    expect(new Set(codes).size).toBe(5_000);
    expect(await prisma.blindId.count({ where: { lotId } })).toBe(5_000);

    // Разрядность расширилась: на трёх знаках пять тысяч кодов не помещаются.
    expect(codes.some((code) => code.length > 3)).toBe(true);
    for (const code of codes) {
      expect(code).toMatch(/^\d{3,5}$/);
    }
  }, 300_000);

  it('повторный запрос возвращает тот же номер', async () => {
    const lotId = await seedLot();
    const [userId] = await seedUsers(1);
    if (userId === undefined) throw new Error('участник не создан');

    const first = await blindIds.codeFor(lotId, userId);
    // Сменивший номер посреди торгов выглядел бы как второй человек.
    expect(await blindIds.codeFor(lotId, userId)).toBe(first);
    expect(await prisma.blindId.count({ where: { lotId, userId } })).toBe(1);
  });

  it('одновременные запросы одного участника дают один номер', async () => {
    const lotId = await seedLot();
    const [userId] = await seedUsers(1);
    if (userId === undefined) throw new Error('участник не создан');

    const codes = await Promise.all(
      Array.from({ length: 20 }, () => blindIds.codeFor(lotId, userId)),
    );

    expect(new Set(codes).size).toBe(1);
    expect(await prisma.blindId.count({ where: { lotId, userId } })).toBe(1);
  });

  it('номер меняется от лота к лоту', async () => {
    const [first, second] = [await seedLot(), await seedLot()];
    const users = await seedUsers(30);

    let differing = 0;
    for (const userId of users) {
      const a = await blindIds.codeFor(first, userId);
      const b = await blindIds.codeFor(second, userId);
      if (a !== b) differing += 1;
    }

    // Совпадай номера между лотами — участники узнавали бы друг друга и могли
    // бы договориться не перебивать (ТЗ §3.1, защита от картеля). Совпадения
    // единичны и случайны, но подавляющее большинство обязано различаться.
    expect(differing).toBeGreaterThan(25);
  });

  it('код выводится из пары «участник + лот», а не из участника', async () => {
    const lotId = await seedLot();
    const [userId] = await seedUsers(1);
    if (userId === undefined) throw new Error('участник не создан');

    const code = await blindIds.codeFor(lotId, userId);
    // Первый кандидат детерминирован (формула ТЗ §3.1): на пустом лоте он и
    // достаётся участнику.
    await prisma.blindId.deleteMany({ where: { lotId, userId } });
    expect(await blindIds.codeFor(lotId, userId)).toBe(code);
  });

  it('в подписи для ленты нет ничего, кроме номера', () => {
    expect(BlindIdService.label('704')).toBe('Инвестор #704');
    // ТЗ §3.1 показывает ровно такой формат: «Инвестор #104», «Инвестор #882».
    expect(BlindIdService.label('0042')).toBe('Инвестор #0042');
  });
});
