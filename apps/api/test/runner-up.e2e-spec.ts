import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidPlacementService } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { DepositPaymentsService } from '../src/deposits/deposit-payments.service';
import { RefundService } from '../src/deposits/refund.service';
import { RUNNER_UP_HOLD_MS, RunnerUpService } from '../src/deposits/runner-up.service';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Runner-Up: опции А и Б (T-038, FR-14, ОВ-10).
 *
 * DoD: оба сценария и автоматический уход удержания в возврат через пять дней.
 * Участник №2 определяется в момент закрытия торгов тем же скриптом, что
 * назвал победителя, — по ставкам в PostgreSQL его вычислять нельзя, они
 * доезжают туда асинхронно.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;
let finisher: FinisherService;
let payments: DepositPaymentsService;
let refunds: RefundService;
let runnerUp: RunnerUpService;
let bank: BankMockProvider;

const START_PRICE_TENGE = 10_000_000;

interface Arena {
  readonly lotId: string;
  readonly winner: string;
  /** Участник №2 — предпоследний, чью ставку приняли. */
  readonly second: string;
  readonly others: readonly string[];
}

/** Четыре допущенных участника, ставят двое: последний побеждает. */
async function arena(): Promise<Arena> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: BigInt(START_PRICE_TENGE) * 100n,
      status: 'PHASE_III',
    },
    select: { id: true, startPriceTiyn: true },
  });
  const session = await prisma.auctionSession.create({
    data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: lot.startPriceTiyn });

  const participants: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const user = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });
    await payments.requestPayment({ lotId: lot.id, userId: user.id });
    const deposit = await prisma.deposit.findFirstOrThrow({
      where: { lotId: lot.id, userId: user.id },
    });
    await payments.handleWebhook(bank.emitPayment(deposit.id, deposit.amountTiyn));
    participants.push(user.id);
  }

  const [second, winner, ...others] = participants as [string, string, ...string[]];
  for (const bidder of [second, winner]) {
    const outcome = await placement.place({
      lotId: lot.id,
      userId: bidder,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
    });
    expect(outcome.status).toBe('ACCEPTED');
  }

  return { lotId: lot.id, winner, second, others };
}

async function finish(lotId: string): Promise<void> {
  await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
  const outcome = await finisher.finishLot(lotId);
  expect(outcome.kind).toBe('FINISHED');
}

async function statusOf(lotId: string, userId: string): Promise<string> {
  const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId } });
  return deposit.status;
}

/** Сдвинуть срок текущего шага в прошлое — вместо ожидания часа или пяти суток. */
async function expireStep(lotId: string, userId: string): Promise<void> {
  await prisma.deposit.updateMany({
    where: { lotId, userId },
    data: { runnerUpUntil: new Date(Date.now() - 1_000) },
  });
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
  finisher = app.get(FinisherService);
  payments = app.get(DepositPaymentsService);
  refunds = app.get(RefundService);
  runnerUp = app.get(RunnerUpService);
  bank = app.get(BankMockProvider);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
  bank.reset();
});

describe('T-038: Runner-Up', () => {
  it('участник №2 — предпоследний, чью ставку приняли', async () => {
    const { lotId, winner, second, others } = await arena();
    await finish(lotId);

    // Выбор предложен ровно одному человеку.
    expect((await runnerUp.view(lotId, second)).offered).toBe(true);
    expect((await runnerUp.view(lotId, winner)).offered).toBe(false);
    for (const other of others) {
      expect((await runnerUp.view(lotId, other)).offered).toBe(false);
      // Остальные проигравшие уходят в возврат сразу, их ничего не спрашивают.
      expect(await statusOf(lotId, other)).toBe('REFUND_PENDING');
    }

    // Задаток участника №2 в общий возврат не попал.
    expect(await statusOf(lotId, second)).toBe('ON_SPECIAL_ACCOUNT');
    await refunds.triggerDue();
    const secondDeposit = await prisma.deposit.findFirstOrThrow({
      where: { lotId, userId: second },
    });
    expect(bank.refundsSent().some((order) => order.reference === secondDeposit.id)).toBe(false);
  });

  it('Опция А: задаток удерживается пять дней', async () => {
    const { lotId, second } = await arena();
    await finish(lotId);

    const before = Date.now();
    const view = await runnerUp.choose({ lotId, userId: second, option: 'A' });
    expect(view.option).toBe('A');
    expect(await statusOf(lotId, second)).toBe('RUNNERUP_HOLD');

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId: second } });
    const until = deposit.runnerUpUntil?.getTime() ?? 0;
    expect(until - before).toBeGreaterThan(RUNNER_UP_HOLD_MS - 5_000);
    expect(until - before).toBeLessThanOrEqual(RUNNER_UP_HOLD_MS + 5_000);

    // Поручения в банк по этому задатку нет: деньги ждут дефолта победителя.
    await refunds.triggerDue();
    expect(bank.refundsSent().some((order) => order.reference === deposit.id)).toBe(false);
  });

  it('DoD: через пять дней удержание само уходит в возврат', async () => {
    const { lotId, second } = await arena();
    await finish(lotId);
    await runnerUp.choose({ lotId, userId: second, option: 'A' });

    await expireStep(lotId, second);
    expect(await runnerUp.expireDue()).toBe(1);
    expect(await statusOf(lotId, second)).toBe('REFUND_PENDING');

    await refunds.triggerDue();
    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId: second } });
    expect(bank.refundsSent().some((order) => order.reference === deposit.id)).toBe(true);
    // Метка остаётся историей: по ней видно, что задаток был задатком №2.
    expect(deposit.runnerUpUntil).not.toBeNull();
    // Второй заход не находит работы: возврат уже запущен.
    expect(await runnerUp.expireDue()).toBe(0);
  });

  it('Опция Б: возврат запускается сразу, срок — сутки от закрытия торгов', async () => {
    const { lotId, second } = await arena();
    const finishedAt = Date.now();
    await finish(lotId);

    const view = await runnerUp.choose({ lotId, userId: second, option: 'B' });
    expect(view.option).toBe('B');
    expect(await statusOf(lotId, second)).toBe('REFUND_PENDING');

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId: second } });
    // Не «сутки от решения»: час размышлений не растягивает обещанные 24 часа.
    const deadline = deposit.refundDeadlineAt?.getTime() ?? 0;
    expect(deadline - finishedAt).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);

    await refunds.triggerDue();
    expect(bank.refundsSent().some((order) => order.reference === deposit.id)).toBe(true);
  });

  it('молчание участника №2 считается Опцией Б', async () => {
    const { lotId, second } = await arena();
    await finish(lotId);

    await expireStep(lotId, second);
    expect(await runnerUp.expireDue()).toBe(1);

    // Молчание возвращает деньги, а не удерживает их.
    expect(await statusOf(lotId, second)).toBe('REFUND_PENDING');
    const audit = await prisma.auditLog.findMany({ where: { entity: 'deposits' } });
    expect(JSON.stringify(audit)).toContain('не ответил');
  });

  it('выбирать может только участник №2 и только в срок', async () => {
    const { lotId, winner, second, others } = await arena();
    await finish(lotId);

    for (const stranger of [winner, ...others]) {
      await expect(runnerUp.choose({ lotId, userId: stranger, option: 'A' })).rejects.toThrow();
    }

    await expireStep(lotId, second);
    // Срок вышел — задаток уходит в возврат по общему правилу, а не по клику.
    await expect(runnerUp.choose({ lotId, userId: second, option: 'A' })).rejects.toThrow();
    expect((await runnerUp.view(lotId, second)).offered).toBe(false);
  });

  it('передумать нельзя: выбор делается один раз', async () => {
    const { lotId, second } = await arena();
    await finish(lotId);

    await runnerUp.choose({ lotId, userId: second, option: 'A' });
    await expect(runnerUp.choose({ lotId, userId: second, option: 'B' })).rejects.toThrow();
    expect(await statusOf(lotId, second)).toBe('RUNNERUP_HOLD');
  });

  it('единственная ставка не создаёт участника №2', async () => {
    const { lotId, second } = await arena();

    // Отматываем к состоянию «была ровно одна ставка».
    await redis.client.hset(state.stateKey(lotId), 'prevBidderId', '', 'prevBlindCode', '');
    await finish(lotId);

    expect((await runnerUp.view(lotId, second)).offered).toBe(false);
    // Никто не завис на спецсчёте, кроме победителя.
    expect(await prisma.deposit.count({ where: { lotId, status: 'ON_SPECIAL_ACCOUNT' } })).toBe(1);
  });
});
