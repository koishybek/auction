import { randomUUID } from 'node:crypto';

import type { DepositView, EgovLoginResult, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DepositPaymentsService } from '../src/deposits/deposit-payments.service';
import { DepositsService } from '../src/deposits/deposits.service';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * REST-контур виджета задатка (T-036, FR-12).
 *
 * Здесь проверяется серверная половина DoD: оплата на моке меняет статус,
 * который читает виджет, и остаток SLA приходит с сервера, а не считается в
 * браузере. Визуальная половина («без перезагрузки») ждёт браузерного
 * харнесса и входа инвестора в web — см. TASKS.md.
 */

let app: INestApplication;
let prisma: PrismaService;
let deposits: DepositsService;
let payments: DepositPaymentsService;
let bank: BankMockProvider;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(tokens: TokenPair): [string, string] {
  return ['Authorization', `Bearer ${tokens.accessToken}`];
}

/** Полный eGov-вход — единственный способ получить верифицированного инвестора. */
async function investor(): Promise<TokenPair> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  // ИИН уникален на пользователя: два инвестора в одном тесте не должны слиться.
  const iin = `9001${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin, fio: 'Инвестор Тестович', biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');
  return result.tokens;
}

async function lotInPhaseTwo(startPriceTenge = 45_000_000): Promise<string> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: BigInt(startPriceTenge) * 100n,
      status: 'PHASE_II',
    },
    select: { id: true },
  });
  return lot.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  deposits = app.get(DepositsService);
  payments = app.get(DepositPaymentsService);
  bank = app.get(BankMockProvider);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  bank.reset();
});

describe('T-036: задаток в кабинете инвестора', () => {
  it('DoD: оплата на моке меняет статус, который читает виджет', async () => {
    const tokens = await investor();
    const lotId = await lotInPhaseTwo();

    const before = await api()
      .get(`/api/lots/${lotId}/deposit`)
      .set(...auth(tokens))
      .expect(200);
    const empty = before.body as DepositView;
    expect(empty.status).toBeNull();
    expect(empty.allowedToBid).toBe(false);
    expect(empty.requiredAmountTenge).toBe(4_500_000);

    const invoiced = await api()
      .post(`/api/lots/${lotId}/deposit/invoice`)
      .set(...auth(tokens))
      .expect(200);
    const issued = invoiced.body as DepositView;
    expect(issued.status).toBe('PENDING');
    expect(issued.payUrl).toMatch(/^https:\/\//);
    expect(issued.allowedToBid).toBe(false);

    // Банк подтверждает платёж вебхуком — это и есть «оплата на моке».
    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId } });
    await payments.handleWebhook(bank.emitPayment(deposit.id, deposit.amountTiyn));

    const after = await api()
      .get(`/api/lots/${lotId}/deposit`)
      .set(...auth(tokens))
      .expect(200);
    const paid = after.body as DepositView;
    expect(paid.status).toBe('ON_SPECIAL_ACCOUNT');
    expect(paid.allowedToBid).toBe(true);
  });

  it('заморозка на карте к торгам ещё не допускает', async () => {
    const tokens = await investor();
    const lotId = await lotInPhaseTwo();

    const held = await api()
      .post(`/api/lots/${lotId}/deposit/hold`)
      .set(...auth(tokens))
      .send({ cardToken: 'tok_visa_4242' })
      .expect(200);

    const view = held.body as DepositView;
    expect(view.status).toBe('HELD');
    // Деньги видны банку, но не лежат на спецсчёте — списать их нельзя.
    expect(view.allowedToBid).toBe(false);
    expect(bank.holdsSent()).toHaveLength(1);
  });

  it('таймер SLA приходит остатком, а не датой', async () => {
    const tokens = await investor();
    const lotId = await lotInPhaseTwo();
    await api()
      .post(`/api/lots/${lotId}/deposit/invoice`)
      .set(...auth(tokens))
      .expect(200);

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId } });
    await payments.handleWebhook(bank.emitPayment(deposit.id, deposit.amountTiyn));
    await deposits.transition({
      depositId: deposit.id,
      to: 'REFUND_PENDING',
      actor: 'SYSTEM',
      actorId: null,
    });

    const response = await api()
      .get(`/api/lots/${lotId}/deposit`)
      .set(...auth(tokens))
      .expect(200);
    const view = response.body as DepositView;

    // Абсолютного времени на проводе нет: часы клиента не участвуют ни в чём.
    expect(JSON.stringify(view)).not.toContain('refundDeadlineAt');
    expect(view.refundRemainingMs).toBeGreaterThan(23 * 3_600_000);
    expect(view.refundRemainingMs).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('десять процентов округляются вверх до целого тенге', async () => {
    const tokens = await investor();
    // 1005 ₸ — десятая часть даёт 100,5 ₸: сумма, которой нет на проводе.
    const lotId = await lotInPhaseTwo(1005);

    const response = await api()
      .get(`/api/lots/${lotId}/deposit`)
      .set(...auth(tokens))
      .expect(200);

    // Вверх, а не вниз: недобор гарантийной суммы недопустим, лишний тенге
    // вернётся вместе с задатком.
    expect((response.body as DepositView).requiredAmountTenge).toBe(101);
  });

  it('чужой задаток не виден', async () => {
    const first = await investor();
    const second = await investor();
    const lotId = await lotInPhaseTwo();

    await api()
      .post(`/api/lots/${lotId}/deposit/invoice`)
      .set(...auth(first))
      .expect(200);

    const response = await api()
      .get(`/api/lots/${lotId}/deposit`)
      .set(...auth(second))
      .expect(200);
    expect((response.body as DepositView).status).toBeNull();
  });

  it('без входа и без верификации к задатку не подойти', async () => {
    const lotId = await lotInPhaseTwo();

    await api().get(`/api/lots/${lotId}/deposit`).expect(401);

    // Роль есть, верификации нет — деньги двигает только подтверждённый человек.
    const unverified = await api()
      .post('/api/auth/dev-login')
      .send({ roles: ['INVESTOR'] })
      .expect(200);
    await api()
      .get(`/api/lots/${lotId}/deposit`)
      .set(...auth(unverified.body as TokenPair))
      .expect(403);
  });

  it('лишнее поле в запросе заморозки отклоняется', async () => {
    const tokens = await investor();
    const lotId = await lotInPhaseTwo();

    // Схемы .strict(): протащить в денежный запрос лишний ключ нельзя (QA-04).
    await api()
      .post(`/api/lots/${lotId}/deposit/hold`)
      .set(...auth(tokens))
      .send({ cardToken: 'tok_visa_4242', amountTenge: 1 })
      .expect(400);
  });
});
