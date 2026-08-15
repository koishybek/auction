import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidPlacementService } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { DepositsService } from '../src/deposits/deposits.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Задатки (T-034, FR-12).
 *
 * DoD: все переходы покрыты юнит-тестами (deposit-status.machine.spec.ts), а
 * допуск к ставкам даёт ровно один статус — это проверяется здесь, на живом
 * пути ставки, а не рассуждением.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;
let deposits: DepositsService;

/** Лот в торгах и верифицированный участник без задатка. */
async function arena(startPriceTenge = 45_000_000): Promise<{ lotId: string; buyer: string }> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: BigInt(startPriceTenge) * 100n,
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
  return { lotId: lot.id, buyer: buyer.id };
}

async function tryBid(lotId: string, userId: string): Promise<string> {
  const result = await placement.place({
    lotId,
    userId,
    expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
  });
  return result.status === 'REJECTED' ? result.code : 'ACCEPTED';
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
  deposits = app.get(DepositsService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-034: задатки', () => {
  it('задаток — десять процентов от стартовой цены', async () => {
    const { lotId, buyer } = await arena(45_000_000);

    // Именно от стартовой, а не от текущей: иначе сумма росла бы вместе с
    // торгами, и внёсший её утром к вечеру оказался бы недоплатившим.
    expect(await deposits.requiredAmountTiyn(lotId)).toBe(450_000_000n);

    const opened = await deposits.open({ lotId, userId: buyer });
    expect(opened.amountTiyn).toBe(450_000_000n);
    expect(opened.status).toBe('PENDING');
  });

  it('повторное открытие возвращает тот же задаток', async () => {
    const { lotId, buyer } = await arena();
    const first = await deposits.open({ lotId, userId: buyer });
    const second = await deposits.open({ lotId, userId: buyer });

    expect(second.id).toBe(first.id);
    expect(await prisma.deposit.count({ where: { lotId, userId: buyer } })).toBe(1);
  });

  it('DoD: к ставкам допускает ровно статус ON_SPECIAL_ACCOUNT', async () => {
    const { lotId, buyer } = await arena();
    const deposit = await deposits.open({ lotId, userId: buyer });

    // PENDING — деньги ещё не наши.
    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');

    // HELD — заблокированы на карте, но не на спецсчёте: списать в пользу
    // продавца их нельзя, значит и ставить рано.
    await deposits.transition({
      depositId: deposit.id,
      to: 'HELD',
      actor: 'BANK',
      actorId: null,
    });
    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');

    await deposits.transition({
      depositId: deposit.id,
      to: 'ON_SPECIAL_ACCOUNT',
      actor: 'BANK',
      actorId: null,
    });
    expect(await tryBid(lotId, buyer)).toBe('ACCEPTED');
  });

  it('запущенный возврат закрывает доступ к торгам', async () => {
    const { lotId, buyer } = await arena();
    const deposit = await deposits.open({ lotId, userId: buyer });
    await deposits.transition({
      depositId: deposit.id,
      to: 'ON_SPECIAL_ACCOUNT',
      actor: 'BANK',
      actorId: null,
    });
    expect(await tryBid(lotId, buyer)).toBe('ACCEPTED');

    await deposits.transition({
      depositId: deposit.id,
      to: 'REFUND_PENDING',
      actor: 'SYSTEM',
      actorId: null,
      reason: 'торги завершены, участник не победил',
    });

    // Второй участник нужен, чтобы отказ был именно про задаток, а не
    // про запрет перебивать себя.
    const other = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });
    const otherDeposit = await deposits.open({ lotId, userId: other.id });
    await deposits.transition({
      depositId: otherDeposit.id,
      to: 'ON_SPECIAL_ACCOUNT',
      actor: 'BANK',
      actorId: null,
    });
    expect(await tryBid(lotId, other.id)).toBe('ACCEPTED');

    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');
  });

  it('переход в возврат ставит срок SLA 24 часа', async () => {
    const { lotId, buyer } = await arena();
    const deposit = await deposits.open({ lotId, userId: buyer });
    await deposits.transition({
      depositId: deposit.id,
      to: 'ON_SPECIAL_ACCOUNT',
      actor: 'BANK',
      actorId: null,
    });

    const before = Date.now();
    await deposits.transition({
      depositId: deposit.id,
      to: 'REFUND_PENDING',
      actor: 'SYSTEM',
      actorId: null,
    });

    // Срок ставится здесь, чтобы воркер возвратов не вычислял его заново и
    // не разошёлся с нами (FR-12).
    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    const deadline = stored.refundDeadlineAt?.getTime() ?? 0;
    expect(deadline - before).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(deadline - before).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
  });

  it('недопустимый переход отклоняется и ничего не меняет', async () => {
    const { lotId, buyer } = await arena();
    const deposit = await deposits.open({ lotId, userId: buyer });

    // Через голову банка деньги на спецсчёт не попадают.
    await expect(
      deposits.transition({
        depositId: deposit.id,
        to: 'ON_SPECIAL_ACCOUNT',
        actor: 'ADMIN',
        actorId: 'admin-1',
      }),
    ).rejects.toThrow();

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('каждое движение денег оставляет след в аудите', async () => {
    const { lotId, buyer } = await arena();
    const deposit = await deposits.open({ lotId, userId: buyer });
    await deposits.transition({
      depositId: deposit.id,
      to: 'ON_SPECIAL_ACCOUNT',
      actor: 'BANK',
      actorId: null,
      reason: 'вебхук банка',
    });

    const audit = await prisma.auditLog.findMany({
      where: { entity: 'deposits', entityId: deposit.id },
    });
    expect(audit).toHaveLength(1);

    const payload = JSON.stringify(audit[0]?.payloadJson);
    expect(payload).toContain('PENDING');
    expect(payload).toContain('ON_SPECIAL_ACCOUNT');
    // Сумма в записи: по одному аудиту должно быть видно, сколько передвинули.
    expect(payload).toContain('450000000');
    expect(payload).toContain('вебхук банка');
  });
});
