import type { EgovLoginResult, RefBonusesView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidOutboxService } from '../src/auction/bid-outbox.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { ProtocolService } from '../src/documents/protocol.service';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { NotificationMockProvider } from '../src/integrations/notifications/notification.mock.provider';
import { PaymentsService } from '../src/payments/payments.service';
import { RefBonusPayoutService } from '../src/payments/ref-bonus-payout.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Выплата Ref-Bonus (T-047, FR-19, ОВ-11).
 *
 * DoD: закрытие сделки доводит долю партнёра до PAID и оставляет запись в
 * уведомлениях. Главное правило — доля платится ИЗ комиссии платформы, а
 * значит только после того, как комиссия собрана: иначе площадка платит из
 * своего кармана за сделку, денег по которой не получила.
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
let payouts: RefBonusPayoutService;
let bank: BankMockProvider;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

async function egovToken(fio: string): Promise<{ token: string; id: string }> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin: randomIin(), fio, biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');

  const me = await api()
    .get('/api/auth/me')
    .set(...auth(result.tokens.accessToken))
    .expect(200);
  return { token: result.tokens.accessToken, id: (me.body as { id: string }).id };
}

async function withRoles(userId: string, roles: readonly string[]): Promise<void> {
  const admin = await api()
    .post('/api/auth/dev-login')
    .send({ roles: ['ADMIN'] })
    .expect(200);
  await api()
    .patch(`/api/admin/users/${userId}/roles`)
    .set(...auth((admin.body as TokenPair).accessToken))
    .send({ roles, reason: 'подготовка сцены теста' })
    .expect(200);
}

interface Deal {
  readonly partnerToken: string;
  readonly lotId: string;
  readonly sellerToken: string;
}

/** Полный путь: лид партнёра → лот → торги → победитель. */
async function dealWithPartner(): Promise<Deal> {
  const partner = await egovToken('Партнёр Тестович');
  await withRoles(partner.id, ['PARTNER']);
  const cadastre = `20-317-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  await api()
    .post('/api/partner/leads')
    .set(...auth(partner.token))
    .send({ ownerIin: randomIin(), ownerPhone: '+77011234567', cadastreOrVin: cadastre })
    .expect(201);

  const seller = await egovToken('Продавец Тестович');
  await withRoles(seller.id, ['SELLER']);
  const created = await api()
    .post('/api/lots')
    .set(...auth(seller.token))
    .send({ type: 'REALTY', cadastreOrVin: cadastre, startPriceTenge: 45_000_000 })
    .expect(201);
  const lotId = (created.body as { id: string }).id;

  await prisma.lot.update({ where: { id: lotId }, data: { status: 'PHASE_III' } });
  const session = await prisma.auctionSession.create({
    data: { lotId, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId, sessionId: session.id, priceTiyn: 4_500_000_000n });

  const winner = await prisma.user.create({
    data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
    select: { id: true },
  });
  await prisma.deposit.create({
    data: { lotId, userId: winner.id, amountTiyn: 450_000_000n, status: 'ON_SPECIAL_ACCOUNT' },
  });
  await bids.place({
    lotId,
    bidderId: winner.id,
    blindCode: 'Инвестор #701',
    expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
  });
  await outbox.drain();

  await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
  expect((await finisher.finishLot(lotId)).kind).toBe('FINISHED');
  await protocols.generateIfComplete(session.id);

  return { partnerToken: partner.token, lotId, sellerToken: seller.token };
}

/**
 * Поручения, ушедшие партнёру.
 *
 * Ищем по назначению платежа, а не сериализацией всего запроса: суммы там
 * `bigint`, и JSON.stringify на нём падает — тот же запрет, что и на проводе.
 */
function partnerOrders(): ReturnType<typeof bank.splitsSent> {
  return bank
    .splitsSent()
    .filter((order) =>
      order.parts.some((part) => part.purpose.includes('Вознаграждение партнёра')),
    );
}

async function bonuses(token: string): Promise<RefBonusesView> {
  const response = await api()
    .get('/api/partner/ref-bonus')
    .set(...auth(token))
    .expect(200);
  return response.body as RefBonusesView;
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
  payouts = app.get(RefBonusPayoutService);
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

describe('T-047: выплата Ref-Bonus', () => {
  it('DoD: закрытие сделки доводит долю до PAID и уведомляет партнёра', async () => {
    const deal = await dealWithPartner();

    // Начислено сразу после торгов, но ещё не выплачено: комиссии нет.
    const accrued = await bonuses(deal.partnerToken);
    expect(accrued.items[0]?.status).toBe('ACCRUED');
    expect(await payouts.payDue()).toBe(0);

    // Продавец подтверждает сделку — победителю выставляется доплата.
    const confirmed = await api()
      .post(`/api/lots/${deal.lotId}/confirm`)
      .set(...auth(deal.sellerToken))
      .expect(200);
    const paymentId = (confirmed.body as { paymentId: string | null }).paymentId ?? '';
    expect(paymentId).toBeTruthy();

    // Доплата пришла и расщепилась: комиссия платформы собрана.
    expect(await payments.devPay(paymentId)).toBe('APPLIED');

    expect(await payouts.payDue()).toBe(1);
    const paid = await bonuses(deal.partnerToken);
    expect(paid.items[0]?.status).toBe('PAID');
    // 2 % от 46 350 000 ₸ = 927 000 ₸.
    expect(paid.items[0]?.amountTenge).toBe(927_000);

    const notifications = await prisma.notification.findMany({
      where: { template: 'partner.ref_bonus_paid' },
    });
    expect(notifications).toHaveLength(1);
    expect(partnerOrders()).toHaveLength(1);
    expect(partnerOrders()[0]?.parts[0]?.amountTiyn).toBe(92_700_000n);
  });

  it('без собранной комиссии доля не платится', async () => {
    const deal = await dealWithPartner();
    await api()
      .post(`/api/lots/${deal.lotId}/confirm`)
      .set(...auth(deal.sellerToken))
      .expect(200);

    // Счёт выставлен, но победитель не заплатил: платить партнёру не из чего.
    expect(await payouts.payDue()).toBe(0);
    expect((await bonuses(deal.partnerToken)).items[0]?.status).toBe('ACCRUED');
  });

  it('повторный заход не платит дважды', async () => {
    const deal = await dealWithPartner();
    const confirmed = await api()
      .post(`/api/lots/${deal.lotId}/confirm`)
      .set(...auth(deal.sellerToken))
      .expect(200);
    await payments.devPay((confirmed.body as { paymentId: string }).paymentId);

    expect(await payouts.payDue()).toBe(1);
    // Повторная выплата — это деньги, которые придётся истребовать обратно.
    expect(await payouts.payDue()).toBe(0);
    expect(await payouts.payDue()).toBe(0);

    expect(partnerOrders()).toHaveLength(1);
  });

  it('после ВЕТО продавца доля не выплачивается', async () => {
    const deal = await dealWithPartner();

    // Сделки нет — комиссия не собрана, платить не из чего.
    await api()
      .post(`/api/lots/${deal.lotId}/veto`)
      .set(...auth(deal.sellerToken))
      .expect(200);

    expect(await payouts.payDue()).toBe(0);
    expect((await bonuses(deal.partnerToken)).items[0]?.status).toBe('ACCRUED');
  });

  it('отказ банка возвращает долю в начисленные', async () => {
    const deal = await dealWithPartner();
    const confirmed = await api()
      .post(`/api/lots/${deal.lotId}/confirm`)
      .set(...auth(deal.sellerToken))
      .expect(200);
    await payments.devPay((confirmed.body as { paymentId: string }).paymentId);

    bank.failSplitOnce();
    expect(await payouts.payDue()).toBe(0);

    // Оставить запись выплаченной значило бы потерять чужие деньги молча.
    expect((await bonuses(deal.partnerToken)).items[0]?.status).toBe('ACCRUED');
    expect(await payouts.payDue()).toBe(1);
    expect((await bonuses(deal.partnerToken)).items[0]?.status).toBe('PAID');
  });

  it('сообщение партнёру содержит сумму', async () => {
    const deal = await dealWithPartner();
    const confirmed = await api()
      .post(`/api/lots/${deal.lotId}/confirm`)
      .set(...auth(deal.sellerToken))
      .expect(200);
    await payments.devPay((confirmed.body as { paymentId: string }).paymentId);
    await payouts.payDue();

    const sent = app.get(NotificationMockProvider).sent();
    expect(JSON.stringify(sent)).toContain('927000');
  });
});
