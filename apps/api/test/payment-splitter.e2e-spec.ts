import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidOutboxService } from '../src/auction/bid-outbox.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { ProtocolService } from '../src/documents/protocol.service';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Payment Splitter (T-046, INT-03).
 *
 * DoD: сумма долей равна платежу до тенге, а повторный вебхук не порождает
 * вторых поручений. И то и другое — про деньги, ушедшие со счёта: лишний
 * перевод возвращают через банк и переписку, а не кнопкой.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let outbox: BidOutboxService;
let finisher: FinisherService;
let protocols: ProtocolService;
let payments: PaymentsService;
let bank: BankMockProvider;

const START_PRICE_TENGE = 45_000_000;

interface Deal {
  readonly lotId: string;
  readonly sessionId: string;
  readonly winnerId: string;
  readonly finalPriceTiyn: bigint;
  readonly depositTiyn: bigint;
}

/** Торги, доведённые до победителя, с задатком победителя на спецсчёте. */
async function closedDeal(lienDebtTiyn = 0n): Promise<Deal> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: BigInt(START_PRICE_TENGE) * 100n,
      status: 'PHASE_III',
      lienDebtTiyn,
    },
    select: { id: true, startPriceTiyn: true },
  });
  const session = await prisma.auctionSession.create({
    data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: lot.startPriceTiyn });

  const winner = await prisma.user.create({
    data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
    select: { id: true },
  });
  const depositTiyn = lot.startPriceTiyn / 10n;
  await prisma.deposit.create({
    data: {
      lotId: lot.id,
      userId: winner.id,
      amountTiyn: depositTiyn,
      status: 'ON_SPECIAL_ACCOUNT',
    },
  });

  const outcome = await bids.place({
    lotId: lot.id,
    bidderId: winner.id,
    blindCode: 'Инвестор #701',
    expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
  });
  expect(outcome.status).toBe('ACCEPTED');
  await outbox.drain();

  await redis.client.hset(state.stateKey(lot.id), 'deadlineMs', String(Date.now() - 1));
  expect((await finisher.finishLot(lot.id)).kind).toBe('FINISHED');
  // Победившая ставка связывается с сессией вместе с протоколом (T-044) —
  // без этого платить некому.
  await protocols.generateIfComplete(session.id);

  const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
  return {
    lotId: lot.id,
    sessionId: session.id,
    winnerId: winner.id,
    finalPriceTiyn: stored.currentPriceTiyn ?? stored.startPriceTiyn,
    depositTiyn,
  };
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
  outbox = app.get(BidOutboxService);
  finisher = app.get(FinisherService);
  protocols = app.get(ProtocolService);
  payments = app.get(PaymentsService);
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

describe('T-046: расщепление доплаты', () => {
  it('доплата — цена минус внесённый задаток', async () => {
    const deal = await closedDeal();
    const opened = await payments.openForWinner(deal.lotId);

    // Не «90 % от цены»: цена выросла за торги, а задаток считался от
    // стартовой. Победитель доплачивает ровно недостающее (ОВ-15).
    expect(opened?.amountTiyn).toBe(deal.finalPriceTiyn - deal.depositTiyn);
  });

  it('DoD: сумма долей равна платежу, поручения ушли в банк', async () => {
    const deal = await closedDeal(500_000_00n);
    const opened = await payments.openForWinner(deal.lotId);
    expect(opened).not.toBeNull();
    const paymentId = opened?.paymentId ?? '';

    expect(await payments.devPay(paymentId)).toBe('APPLIED');

    const splits = await prisma.payoutSplit.findMany({ where: { paymentId } });
    expect(splits).toHaveLength(3);

    const total = splits.reduce((sum, split) => sum + split.amountTiyn, 0n);
    expect(total).toBe(opened?.amountTiyn);
    // Ничьих тиынов не остаётся: остаток продавцу считается вычитанием.
    expect(splits.every((split) => split.amountTiyn % 100n === 0n)).toBe(true);

    const byKind = new Map(splits.map((split) => [split.kind, split.amountTiyn]));
    // 5 % от итоговой цены 46 350 000 ₸ = 2 317 500 ₸.
    expect(byKind.get('FEE_5PCT')).toBe(231_750_000n);
    expect(byKind.get('BANK_DEBT')).toBe(500_000_00n);

    // Поручения ушли в банк одним расщеплением.
    expect(bank.splitsSent()).toHaveLength(1);
    expect(bank.splitsSent()[0]?.parts).toHaveLength(3);
    expect(splits.every((split) => split.status === 'SENT')).toBe(true);

    /**
     * У каждой доли свой номер банковской операции (T-055).
     *
     * Раньше во все три строки писался общий идентификатор расщепления, и при
     * отказе одного перевода сверить его с выпиской было нечем: у отклонённого и
     * у прошедших один и тот же номер. Спор о неполученных деньгах продавца
     * разбирается именно по номеру операции.
     */
    const refs = splits.map((split) => split.bankRef);
    expect(refs.every((ref) => ref !== null && ref !== '')).toBe(true);
    expect(new Set(refs).size).toBe(3);
  });

  it('DoD: повторный вебхук не создаёт вторых поручений', async () => {
    const deal = await closedDeal();
    const opened = await payments.openForWinner(deal.lotId);
    const paymentId = opened?.paymentId ?? '';

    const event = bank.emitPayment(paymentId, opened?.amountTiyn ?? 0n);
    expect(await payments.handleWebhook(event)).toBe('APPLIED');
    expect(await payments.handleWebhook(event)).toBe('DUPLICATE');
    expect(await payments.handleWebhook(event)).toBe('DUPLICATE');

    // Лишний перевод возвращают через банк и переписку, а не кнопкой.
    expect(await prisma.payoutSplit.count({ where: { paymentId } })).toBe(3);
    expect(bank.splitsSent()).toHaveLength(1);
  });

  it('без залога доля залогодержателя нулевая и в банк не уходит', async () => {
    const deal = await closedDeal(0n);
    const opened = await payments.openForWinner(deal.lotId);
    const paymentId = opened?.paymentId ?? '';
    await payments.devPay(paymentId);

    const splits = await prisma.payoutSplit.findMany({ where: { paymentId } });
    const byKind = new Map(splits.map((split) => [split.kind, split.amountTiyn]));
    expect(byKind.get('BANK_DEBT')).toBe(0n);

    // Пустое поручение банку не отправляется: перевод нуля — это шум в выписке.
    expect(bank.splitsSent()[0]?.parts).toHaveLength(2);
  });

  it('платёж не на ту сумму расщепление не запускает', async () => {
    const deal = await closedDeal();
    const opened = await payments.openForWinner(deal.lotId);
    const paymentId = opened?.paymentId ?? '';

    await payments.handleWebhook(bank.emitPayment(paymentId, (opened?.amountTiyn ?? 0n) - 100n));

    // Недоплата — не повод раздать деньги по счетам.
    expect(await prisma.payoutSplit.count({ where: { paymentId } })).toBe(0);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('PENDING');
  });

  it('неоплаченную доплату расщепить нельзя', async () => {
    const deal = await closedDeal();
    const opened = await payments.openForWinner(deal.lotId);

    await expect(payments.split(opened?.paymentId ?? '')).rejects.toThrow();
  });

  it('повторное открытие доплаты не плодит счетов', async () => {
    const deal = await closedDeal();
    const first = await payments.openForWinner(deal.lotId);
    const second = await payments.openForWinner(deal.lotId);

    expect(second?.paymentId).toBe(first?.paymentId);
    expect(await prisma.payment.count({ where: { lotId: deal.lotId } })).toBe(1);
  });
});
