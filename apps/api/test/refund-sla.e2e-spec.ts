import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidOutboxService } from '../src/auction/bid-outbox.service';
import { BidPlacementService } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { DepositPaymentsService } from '../src/deposits/deposit-payments.service';
import { DepositsService } from '../src/deposits/deposits.service';
import { RefundService } from '../src/deposits/refund.service';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Авто-возврат задатков (T-037, INT-04, FR-12).
 *
 * DoD: три проигравших дают ровно три поручения в банк при двойном запуске
 * воркера. Двойной возврат хуже опоздания: со второго перевода деньги
 * приходится истребовать обратно, и это уже спор, а не операция.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;
let finisher: FinisherService;
let deposits: DepositsService;
let payments: DepositPaymentsService;
let refunds: RefundService;
let outbox: BidOutboxService;
let bank: BankMockProvider;

const START_PRICE_TENGE = 10_000_000;

interface Arena {
  readonly lotId: string;
  /** Победитель — единственный, кто поставил. */
  readonly winner: string;
  readonly losers: readonly string[];
}

/** Лот в торгах, четыре допущенных участника, ставку делает один. */
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

  const winner = first(participants);
  await placement.place({
    lotId: lot.id,
    userId: winner,
    expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
  });
  // В e2e воркеры не подняты: переносим ставку в PostgreSQL руками — сверка
  // возвратов определяет победителя именно по строкам ставок.
  await outbox.drain();

  return { lotId: lot.id, winner, losers: participants.slice(1) };
}

/** Закрыть торги здесь и сейчас. */
async function finish(lotId: string): Promise<void> {
  await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
  const outcome = await finisher.finishLot(lotId);
  expect(outcome.kind).toBe('FINISHED');
}

/** Первый из списка. Пустой список здесь означает сломанную подготовку теста. */
function first(list: readonly string[]): string {
  const value = list[0];
  if (value === undefined) {
    throw new Error('участников нет — арена собралась неправильно');
  }
  return value;
}

async function statusOf(lotId: string, userId: string): Promise<string> {
  const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId } });
  return deposit.status;
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
  deposits = app.get(DepositsService);
  payments = app.get(DepositPaymentsService);
  refunds = app.get(RefundService);
  outbox = app.get(BidOutboxService);
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

describe('T-037: авто-возврат SLA 24 часа', () => {
  it('DoD: три проигравших — три поручения, при двойном воркере тоже три', async () => {
    const { lotId, winner, losers } = await arena();
    await finish(lotId);

    // Возвраты открылись в момент закрытия торгов, поручений ещё нет.
    for (const loser of losers) {
      expect(await statusOf(lotId, loser)).toBe('REFUND_PENDING');
    }
    expect(await statusOf(lotId, winner)).toBe('ON_SPECIAL_ACCOUNT');
    expect(bank.refundsSent()).toHaveLength(0);

    // Два воркера заходят одновременно — ровно то, что бывает в двух подах.
    const [sentByA, sentByB] = await Promise.all([refunds.triggerDue(), refunds.triggerDue()]);
    expect(sentByA + sentByB).toBe(3);

    const sent = bank.refundsSent();
    expect(sent).toHaveLength(3);
    // Три РАЗНЫХ задатка, а не одно поручение, отправленное трижды.
    expect(new Set(sent.map((order) => order.reference)).size).toBe(3);

    // Третий и четвёртый заходы не находят работы.
    await refunds.triggerDue();
    await refunds.triggerDue();
    expect(bank.refundsSent()).toHaveLength(3);
  });

  it('победителю задаток не возвращают', async () => {
    const { lotId, winner } = await arena();
    await finish(lotId);
    await refunds.triggerDue();

    // Его деньги остаются на спецсчёте: пойдут в зачёт доплаты либо будут
    // удержаны, если он не рассчитается.
    expect(await statusOf(lotId, winner)).toBe('ON_SPECIAL_ACCOUNT');
    const winnerDeposit = await prisma.deposit.findFirstOrThrow({
      where: { lotId, userId: winner },
    });
    expect(bank.refundsSent().some((order) => order.reference === winnerDeposit.id)).toBe(false);
  });

  it('торги без единой ставки возвращают задатки всем', async () => {
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

    const user = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });
    await payments.requestPayment({ lotId: lot.id, userId: user.id });
    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId: lot.id } });
    await payments.handleWebhook(bank.emitPayment(deposit.id, deposit.amountTiyn));

    // Победителя нет — торги состоялись, покупателя не нашлось.
    await finish(lot.id);
    expect(await statusOf(lot.id, user.id)).toBe('REFUND_PENDING');

    await refunds.triggerDue();
    expect(bank.refundsSent()).toHaveLength(1);
  });

  it('срок возврата — 24 часа с закрытия торгов', async () => {
    const { lotId, losers } = await arena();
    const before = Date.now();
    await finish(lotId);

    const deposit = await prisma.deposit.findFirstOrThrow({
      where: { lotId, userId: first(losers) },
    });
    const deadline = deposit.refundDeadlineAt?.getTime() ?? 0;
    expect(deadline - before).toBeGreaterThan(23 * 3_600_000);
    expect(deadline - before).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);
  });

  it('поручение уходит без НДС и с КБЕ, обратный адрес — за банком', async () => {
    const { lotId } = await arena();
    await finish(lotId);
    await refunds.triggerDue();

    const order = bank.refundsSent()[0];
    expect(order?.kbe).toBe('19');
    expect(order?.purpose).toContain('Без НДС');
    // Реквизитов участника у нас нет: деньги идут туда, откуда пришли.
    expect(order?.iban).toBeNull();
  });

  it('отказ банка не теряет возврат — следующий заход отправляет снова', async () => {
    const { lotId, losers } = await arena();
    await finish(lotId);

    bank.failRefundOnce();
    const sent = await refunds.triggerDue();
    // Один из трёх не прошёл.
    expect(sent).toBe(2);
    expect(bank.refundsSent()).toHaveLength(2);

    // Заявка освобождена, а не помечена отправленной.
    const stuck = await prisma.deposit.count({
      where: { lotId, status: 'REFUND_PENDING', refundRef: null },
    });
    expect(stuck).toBe(1);

    expect(await refunds.triggerDue()).toBe(1);
    expect(bank.refundsSent()).toHaveLength(3);
    expect(new Set(bank.refundsSent().map((order) => order.reference)).size).toBe(3);
    expect(losers).toHaveLength(3);
  });

  it('вебхук банка закрывает возврат', async () => {
    const { lotId, losers } = await arena();
    await finish(lotId);
    await refunds.triggerDue();

    for (const loser of losers) {
      const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId: loser } });
      await payments.handleWebhook(bank.emitRefund(deposit.id, deposit.amountTiyn));
    }

    for (const loser of losers) {
      expect(await statusOf(lotId, loser)).toBe('REFUNDED');
    }
  });

  it('сверка подбирает лот, где возвраты не открылись', async () => {
    const { lotId, winner, losers } = await arena();
    await finish(lotId);

    // Как будто finisher до шага возвратов не дошёл: база моргнула.
    await prisma.deposit.updateMany({
      where: { lotId, status: 'REFUND_PENDING' },
      data: { status: 'ON_SPECIAL_ACCOUNT', refundDeadlineAt: null },
    });

    // Сверка ждёт минуту после закрытия — сразу она не вмешивается.
    expect(await refunds.reconcileFinishedLots()).toBe(0);
    await prisma.auctionSession.updateMany({
      where: { lotId },
      data: { finishedAt: new Date(Date.now() - 120_000) },
    });

    // Победителя сверка берёт из ставок, а не из памяти finisher'а.
    expect(await refunds.reconcileFinishedLots()).toBe(losers.length);
    expect(await statusOf(lotId, winner)).toBe('ON_SPECIAL_ACCOUNT');
    for (const loser of losers) {
      expect(await statusOf(lotId, loser)).toBe('REFUND_PENDING');
    }
  });

  /**
   * Регресс (T-055): сверка обязана дозакрывать не только возвраты.
   *
   * Возвраты, предложение участнику №2 (FR-14) и бонус партнёра (FR-19) —
   * один и тот же шаг закрытия лота, и падает он целиком. Сверка при этом
   * раньше открывала только возвраты: участник №2 получал возврат как обычный
   * проигравший и терял право выбора, а бонус партнёра не начислялся уже
   * никогда — второго места, откуда его начисляют, в системе нет.
   */
  it('регресс: сверка возвращает участнику №2 его выбор и начисляет бонус партнёра', async () => {
    const { lotId, winner, losers } = await arena();
    const second = first(losers);

    // Вторая ставка — от участника, который станет №2 после перебивки.
    await placement.place({
      lotId,
      userId: second,
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    await placement.place({
      lotId,
      userId: winner,
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    await outbox.drain();

    // Лот пришёл от партнёра: на нём висит доля 2 % (FR-19).
    const partner = await prisma.user.create({
      data: { roles: ['PARTNER'] },
      select: { id: true },
    });
    await prisma.partnerLead.create({
      data: {
        partnerId: partner.id,
        lotId,
        cadastreOrVin: `LEAD-${randomUUID()}`,
        status: 'LOCKED',
        lockedUntil: new Date(Date.now() + 86_400_000),
        // Контакт владельца — шифрованная колонка. Здесь её никто не
        // расшифровывает: тесту важна связь «лот пришёл от партнёра».
        ownerContactEnc: Buffer.from('фикстура T-055'),
      },
    });

    await finish(lotId);

    // Как будто finisher упал на шаге возвратов: ни возвратов, ни предложения
    // участнику №2, ни бонуса.
    await prisma.deposit.updateMany({
      where: { lotId },
      data: { status: 'ON_SPECIAL_ACCOUNT', refundDeadlineAt: null, runnerUpUntil: null },
    });
    await prisma.refBonus.deleteMany({ where: { lotId } });
    await prisma.auctionSession.updateMany({
      where: { lotId },
      data: { finishedAt: new Date(Date.now() - 120_000) },
    });

    await refunds.reconcileFinishedLots();

    // Участник №2 не в общем возврате: у него метка срока и выбор из двух опций.
    const runnerUpDeposit = await prisma.deposit.findFirstOrThrow({
      where: { lotId, userId: second },
    });
    expect(runnerUpDeposit.status).toBe('ON_SPECIAL_ACCOUNT');
    expect(runnerUpDeposit.runnerUpUntil).not.toBeNull();

    // Победителю не возвращают, остальным — возвращают.
    expect(await statusOf(lotId, winner)).toBe('ON_SPECIAL_ACCOUNT');
    for (const loser of losers.slice(1)) {
      expect(await statusOf(lotId, loser)).toBe('REFUND_PENDING');
    }

    // Бонус партнёра начислен — от победной цены, а не от стартовой.
    const bonus = await prisma.refBonus.findFirstOrThrow({ where: { lotId } });
    expect(bonus.status).toBe('ACCRUED');
    expect(bonus.amountTiyn).toBeGreaterThan(0n);

    // Повторный заход ничего не дублирует: сверка идемпотентна.
    await refunds.reconcileFinishedLots();
    expect(await prisma.refBonus.count({ where: { lotId } })).toBe(1);
  });

  it('сверка не трогает лот, чьи ставки ещё не доехали в базу', async () => {
    const { lotId } = await arena();
    await finish(lotId);
    await prisma.deposit.updateMany({
      where: { lotId, status: 'REFUND_PENDING' },
      data: { status: 'ON_SPECIAL_ACCOUNT', refundDeadlineAt: null },
    });
    await prisma.auctionSession.updateMany({
      where: { lotId },
      data: { finishedAt: new Date(Date.now() - 120_000) },
    });

    // Цена лота выросла — значит ставки были. Строк в базе нет: outbox отстал.
    await prisma.bid.deleteMany({ where: { lotId } });

    // Вернуть задаток победителю хуже, чем вернуть на минуту позже.
    expect(await refunds.reconcileFinishedLots()).toBe(0);
    expect(await prisma.deposit.count({ where: { lotId, status: 'ON_SPECIAL_ACCOUNT' } })).toBe(4);
  });

  it('просроченный возврат виден как инцидент', async () => {
    const { lotId, winner, losers } = await arena();
    await finish(lotId);
    expect(await refunds.overdue()).toBe(0);

    // Сутки прошли, банк не подтвердил. Само по себе это не чинится кодом —
    // деньги у банка, — но молчать о нарушении SLA нельзя.
    await prisma.deposit.updateMany({
      where: { lotId, userId: { in: [...losers] } },
      data: { refundDeadlineAt: new Date(Date.now() - 60_000) },
    });
    expect(await refunds.overdue()).toBe(3);

    // Открытие возвратов идемпотентно: повтор ничего не удваивает.
    expect(await deposits.openRefundsForLot(lotId, { winnerUserId: winner })).toBe(0);
  });
});
