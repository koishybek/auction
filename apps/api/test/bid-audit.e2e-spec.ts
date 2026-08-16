import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidPlacementService } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Аудит отклонённых ставок (T-048, QA-04).
 *
 * DoD: подмена суммы отклоняется и ВИДНА в audit_log. Второе не менее важно
 * первого: отказ без следа означает, что о попытке никто не узнает, а
 * приёмочный тест ТЗ §6 требует показать именно попытку.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;

interface Arena {
  readonly lotId: string;
  readonly buyer: string;
}

async function arena(): Promise<Arena> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: 4_500_000_000n,
      status: 'PHASE_III',
    },
    select: { id: true, startPriceTiyn: true },
  });
  const session = await prisma.auctionSession.create({
    data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: lot.startPriceTiyn });

  const buyer = await prisma.user.create({
    data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
    select: { id: true },
  });
  await prisma.deposit.create({
    data: {
      lotId: lot.id,
      userId: buyer.id,
      amountTiyn: 450_000_000n,
      status: 'ON_SPECIAL_ACCOUNT',
    },
  });
  return { lotId: lot.id, buyer: buyer.id };
}

/** Запись аудита пишется мимо критического пути — ждём её появления. */
async function auditRows(lotId: string, expected = 1): Promise<{ payloadJson: unknown }[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: { action: 'bid.rejected', entityId: lotId },
      select: { payloadJson: true },
    });
    if (rows.length >= expected || Date.now() > deadline) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  state = app.get(AuctionStateService);
  bids = app.get(BidService);
  placement = app.get(BidPlacementService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-048: аудит подмены суммы', () => {
  it('DoD: присланная сумма отклоняется и попадает в audit_log', async () => {
    const { lotId, buyer } = await arena();
    const honest = await bids.nextPriceTiyn(lotId);

    // Сценарий ТЗ §6: в DevTools правят сумму на «поменьше» и шлют.
    const tampered = honest - 1_000_000n;
    const result = await placement.place({
      lotId,
      userId: buyer,
      expectedAmountTiyn: tampered,
      sessionId: 'session-devtools',
      ip: '203.0.113.7',
    });

    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.code).toBe('PRICE_MISMATCH');

    const rows = await auditRows(lotId);
    expect(rows).toHaveLength(1);

    const payload = JSON.stringify(rows[0]?.payloadJson);
    expect(payload).toContain('PRICE_MISMATCH');
    // В записи видно и что прислали, и что ждал сервер: по одному коду
    // непонятно, промахнулся человек или перебирал суммы.
    expect(payload).toContain(tampered.toString());
    expect(payload).toContain(honest.toString());
    expect(payload).toContain('203.0.113.7');
    expect(payload).toContain('session-devtools');
  });

  it('принятая ставка аудитом не дублируется', async () => {
    const { lotId, buyer } = await arena();
    const result = await placement.place({
      lotId,
      userId: buyer,
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    expect(result.status).toBe('ACCEPTED');

    // Принятые ставки уже лежат в bids — append-only и с серверным временем.
    // Вторая запись о том же факте только мешала бы разбирательству.
    expect(await auditRows(lotId, 0)).toHaveLength(0);
  });

  it('отказ по частоте в аудит не пишется', async () => {
    const { lotId, buyer } = await arena();
    const amount = await bids.nextPriceTiyn(lotId);

    const first = await placement.place({
      lotId,
      userId: buyer,
      expectedAmountTiyn: amount,
      sessionId: 'session-fast',
    });
    const second = await placement.place({
      lotId,
      userId: buyer,
      expectedAmountTiyn: amount,
      sessionId: 'session-fast',
    });

    expect(first.status).toBe('ACCEPTED');
    expect(second.status === 'REJECTED' && second.code).toBe('RATE_LIMITED');

    // Автокликер даёт такие отказы сотнями: запись каждого превратила бы
    // защиту от нагрузки в способ её создать.
    expect(await auditRows(lotId, 0)).toHaveLength(0);
  });

  it('отказ без задатка тоже оставляет след', async () => {
    const { lotId } = await arena();
    const stranger = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });

    const result = await placement.place({
      lotId,
      userId: stranger.id,
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    expect(result.status === 'REJECTED' && result.code).toBe('NO_DEPOSIT');

    const rows = await auditRows(lotId);
    expect(JSON.stringify(rows[0]?.payloadJson)).toContain('NO_DEPOSIT');
  });

  it('всплеск подмен поднимает инцидент администраторам', async () => {
    const { lotId, buyer } = await arena();
    await prisma.user.create({ data: { roles: ['ADMIN'] }, select: { id: true } });
    const honest = await bids.nextPriceTiyn(lotId);

    // Десять промахов подряд по одному лоту — это уже перебор сумм, а не
    // невезение: между отрисовкой кнопки и кликом столько раз не бывает.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await placement.place({
        lotId,
        userId: buyer,
        expectedAmountTiyn: honest - BigInt(attempt + 1) * 100n,
      });
    }

    await auditRows(lotId, 10);
    const deadline = Date.now() + 5_000;
    let alerts: number = 0;
    while (Date.now() < deadline) {
      alerts = await prisma.notification.count({
        where: { template: 'security.bid_amount_tampering' },
      });
      if (alerts > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alerts).toBe(1);
  });
});
