import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidPlacementService } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { DepositPaymentsService } from '../src/deposits/deposit-payments.service';
import { DepositsService } from '../src/deposits/deposits.service';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Банк-адаптер (T-035, INT-03/INT-04, ОВ-3).
 *
 * DoD: полный цикл на моке — инвойс → вебхук оплаты → задаток
 * ON_SPECIAL_ACCOUNT. Цикл проверяется до конца, до принятой ставки: смысл
 * задатка в допуске к торгам, и «статус поменялся» само по себе ничего не
 * доказывает.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;
let deposits: DepositsService;
let payments: DepositPaymentsService;
let bank: BankMockProvider;

const START_PRICE_TENGE = 45_000_000;
/** Десять процентов стартовой цены в тиынах — 4 500 000 ₸. */
const DEPOSIT_TIYN = (BigInt(START_PRICE_TENGE) * 100n) / 10n;

async function arena(): Promise<{ lotId: string; buyer: string }> {
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
  payments = app.get(DepositPaymentsService);
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

describe('T-035: банк-адаптер', () => {
  it('DoD: инвойс → вебхук оплаты → задаток на спецсчёте → ставка принята', async () => {
    const { lotId, buyer } = await arena();

    const invoice = await payments.requestPayment({ lotId, userId: buyer });
    expect(invoice.amountTiyn).toBe(DEPOSIT_TIYN);
    expect(invoice.payUrl).toMatch(/^https:\/\//);

    // До оплаты ставить нельзя — счёт выставлен, деньги не пришли.
    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');

    const outcome = await payments.handleWebhook(bank.emitPayment(invoice.depositId, DEPOSIT_TIYN));
    expect(outcome.kind).toBe('APPLIED');

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: invoice.depositId } });
    expect(stored.status).toBe('ON_SPECIAL_ACCOUNT');
    expect(stored.bankRef).not.toBeNull();

    expect(await tryBid(lotId, buyer)).toBe('ACCEPTED');
  });

  it('инвойс уходит на спецсчёт, с КБЕ и назначением без НДС', async () => {
    const { lotId, buyer } = await arena();
    await payments.requestPayment({ lotId, userId: buyer });

    const sent = bank.invoicesSent();
    expect(sent).toHaveLength(1);
    const request = sent[0];
    expect(request?.amountTiyn).toBe(DEPOSIT_TIYN);
    expect(request?.iban).toMatch(/^KZ/);
    expect(request?.kbe).toBe('19');
    // Без пометки банк проведёт задаток как облагаемый оборот (ТЗ §5.2).
    expect(request?.purpose).toContain('Без НДС');
  });

  it('повторная доставка вебхука ничего не удваивает', async () => {
    const { lotId, buyer } = await arena();
    const invoice = await payments.requestPayment({ lotId, userId: buyer });
    const event = bank.emitPayment(invoice.depositId, DEPOSIT_TIYN);

    // Банк повторяет вебхук, пока не получит подтверждения. Одно и то же
    // событие обязано доехать сколько угодно раз с одним результатом.
    expect((await payments.handleWebhook(event)).kind).toBe('APPLIED');
    expect((await payments.handleWebhook(event)).kind).toBe('DUPLICATE');
    expect((await payments.handleWebhook(event)).kind).toBe('DUPLICATE');

    const audit = await prisma.auditLog.findMany({
      where: { entity: 'deposits', entityId: invoice.depositId },
    });
    expect(audit).toHaveLength(1);
  });

  it('платёж не на ту сумму к торгам не допускает', async () => {
    const { lotId, buyer } = await arena();
    const invoice = await payments.requestPayment({ lotId, userId: buyer });

    // Недоплаченный задаток — не задаток. Один тиын разницы значит столько же,
    // сколько миллион: сумма либо сошлась, либо нет.
    const outcome = await payments.handleWebhook(
      bank.emitPayment(invoice.depositId, DEPOSIT_TIYN - 1n),
    );
    expect(outcome.kind).toBe('AMOUNT_MISMATCH');

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: invoice.depositId } });
    expect(stored.status).toBe('PENDING');
    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');
  });

  it('неудачный платёж оставляет задаток неоплаченным', async () => {
    const { lotId, buyer } = await arena();
    const invoice = await payments.requestPayment({ lotId, userId: buyer });

    bank.failPaymentOnce();
    await payments.handleWebhook(bank.emitPayment(invoice.depositId, DEPOSIT_TIYN));

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: invoice.depositId } });
    expect(stored.status).toBe('PENDING');
    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');

    // Со второй попытки платёж проходит — отказ банка не выжигает задаток.
    await payments.handleWebhook(bank.emitPayment(invoice.depositId, DEPOSIT_TIYN));
    expect(await tryBid(lotId, buyer)).toBe('ACCEPTED');
  });

  it('вебхук с чужой ссылкой не находит задатка и ничего не трогает', async () => {
    const { lotId, buyer } = await arena();
    await payments.requestPayment({ lotId, userId: buyer });

    const outcome = await payments.handleWebhook(bank.emitPayment(randomUUID(), DEPOSIT_TIYN));
    expect(outcome.kind).toBe('UNKNOWN_REFERENCE');
    expect(await tryBid(lotId, buyer)).toBe('NO_DEPOSIT');
  });

  it('повторный запрос счёта не плодит задатков', async () => {
    const { lotId, buyer } = await arena();
    const first = await payments.requestPayment({ lotId, userId: buyer });
    const second = await payments.requestPayment({ lotId, userId: buyer });

    expect(second.depositId).toBe(first.depositId);
    expect(await prisma.deposit.count({ where: { lotId, userId: buyer } })).toBe(1);
  });

  it('возврат уходит поручением без НДС и закрывается вебхуком', async () => {
    const { lotId, buyer } = await arena();
    const invoice = await payments.requestPayment({ lotId, userId: buyer });
    await payments.handleWebhook(bank.emitPayment(invoice.depositId, DEPOSIT_TIYN));

    await deposits.transition({
      depositId: invoice.depositId,
      to: 'REFUND_PENDING',
      actor: 'SYSTEM',
      actorId: null,
      reason: 'торги завершены, участник не победил',
    });
    await payments.requestRefund(invoice.depositId, 'KZ11111111111111111111');

    const order = bank.refundsSent()[0];
    expect(order?.amountTiyn).toBe(DEPOSIT_TIYN);
    expect(order?.iban).toBe('KZ11111111111111111111');
    expect(order?.kbe).toBe('19');
    // Возврат задатка НДС не облагается (ТЗ §5.2, INT-04).
    expect(order?.purpose).toContain('Без НДС');

    await payments.handleWebhook(bank.emitRefund(invoice.depositId, DEPOSIT_TIYN));
    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: invoice.depositId } });
    expect(stored.status).toBe('REFUNDED');
  });

  it('подтверждение возврата в обход REFUND_PENDING не проходит', async () => {
    const { lotId, buyer } = await arena();
    const invoice = await payments.requestPayment({ lotId, userId: buyer });
    await payments.handleWebhook(bank.emitPayment(invoice.depositId, DEPOSIT_TIYN));

    // Деньги на спецсчёте, поручения не было — «возврат подтверждён» тут
    // означает потерянную запись, а не возвращённые деньги.
    await expect(
      payments.handleWebhook(bank.emitRefund(invoice.depositId, DEPOSIT_TIYN)),
    ).rejects.toThrow();

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: invoice.depositId } });
    expect(stored.status).toBe('ON_SPECIAL_ACCOUNT');
  });

  it('hold и split доходят до банка в тиынах', async () => {
    // Обе операции нужны Фазе 6 (INT-03), здесь фиксируется только контракт:
    // суммы целые, ничего по дороге не теряется.
    await bank.holdCard({ reference: 'ref-1', amountTiyn: 450_000_000n, cardToken: 'tok_test' });
    expect(bank.holdsSent()[0]?.amountTiyn).toBe(450_000_000n);

    await bank.split({
      reference: 'ref-2',
      parts: [
        { iban: 'KZ1', kbe: '17', amountTiyn: 100n, purpose: 'Комиссия платформы 5 %' },
        { iban: 'KZ2', kbe: '17', amountTiyn: 900n, purpose: 'Продавцу' },
      ],
    });
    const split = bank.splitsSent()[0];
    expect(split?.parts).toHaveLength(2);
    expect(split?.parts.reduce((sum, part) => sum + part.amountTiyn, 0n)).toBe(1000n);
  });
});
