import { randomUUID } from 'node:crypto';

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
import { NotificationMockProvider } from '../src/integrations/notifications/notification.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Ref-Bonus (T-043, FR-19, ОВ-11).
 *
 * DoD: прогноз идёт за ценой, а после закрытия торгов превращается в
 * начисление. Прогноз нигде не хранится — иначе он устаревал бы следующей
 * ставкой и однажды показал бы партнёру не ту сумму.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let outbox: BidOutboxService;
let finisher: FinisherService;

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

/** Лид партнёра, лот продавца по тому же объекту и открытые торги. */
async function scene(): Promise<{ partnerToken: string; lotId: string; buyers: string[] }> {
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

  // Лид должен был привязаться к лоту сам — от этой связи считается доля.
  const lead = await prisma.partnerLead.findFirstOrThrow({ where: { cadastreOrVin: cadastre } });
  expect(lead.lotId).toBe(lotId);
  expect(lead.status).toBe('CONVERTED');

  await prisma.lot.update({ where: { id: lotId }, data: { status: 'PHASE_III' } });
  const session = await prisma.auctionSession.create({
    data: { lotId, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId, sessionId: session.id, priceTiyn: 4_500_000_000n });

  const buyers: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const buyer = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });
    buyers.push(buyer.id);
  }

  return { partnerToken: partner.token, lotId, buyers };
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
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-043: Ref-Bonus партнёра', () => {
  it('DoD: прогноз идёт за ценой, а после закрытия становится начислением', async () => {
    const { partnerToken, lotId, buyers } = await scene();

    // До ставок прогноз считается от стартовой цены: 2 % от 45 000 000 ₸.
    const before = await bonuses(partnerToken);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.status).toBe('FORECAST');
    expect(before.items[0]?.amountTenge).toBe(900_000);

    await bids.place({
      lotId,
      bidderId: buyers[0] ?? '',
      blindCode: 'Инвестор #701',
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    // Прогноз считается по записанным ставкам: в e2e воркер переноса не поднят.
    await outbox.drain();

    // Цена стала 46 350 000 ₸ — прогноз обязан идти за ней, а не отставать.
    const afterBid = await bonuses(partnerToken);
    expect(afterBid.items[0]?.status).toBe('FORECAST');
    expect(afterBid.items[0]?.amountTenge).toBe(927_000);

    await bids.place({
      lotId,
      bidderId: buyers[1] ?? '',
      blindCode: 'Инвестор #702',
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    // Прогноз считается по записанным ставкам: в e2e воркер переноса не поднят.
    await outbox.drain();
    const afterSecond = await bonuses(partnerToken);
    // 47 740 500 ₸ × 2 % = 954 810 ₸.
    expect(afterSecond.items[0]?.amountTenge).toBe(954_810);

    // Закрытие торгов: цена больше не изменится, прогноз становится фактом.
    await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
    expect((await finisher.finishLot(lotId)).kind).toBe('FINISHED');

    const accrued = await bonuses(partnerToken);
    expect(accrued.items).toHaveLength(1);
    expect(accrued.items[0]?.status).toBe('ACCRUED');
    expect(accrued.items[0]?.amountTenge).toBe(954_810);

    // Запись одна: повторное закрытие ничего не удваивает.
    expect(await prisma.refBonus.count({ where: { lotId } })).toBe(1);
  });

  it('партнёр получает уведомление о начислении', async () => {
    const { partnerToken, lotId, buyers } = await scene();
    await bids.place({
      lotId,
      bidderId: buyers[0] ?? '',
      blindCode: 'Инвестор #701',
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    // Прогноз считается по записанным ставкам: в e2e воркер переноса не поднят.
    await outbox.drain();

    await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
    await finisher.finishLot(lotId);
    await bonuses(partnerToken);

    // О своих деньгах партнёр не должен узнавать, заглянув в кабинет (FR-19).
    const notifications = await prisma.notification.findMany({
      where: { template: 'partner.ref_bonus_accrued' },
    });
    expect(notifications).toHaveLength(1);

    // Сумма ушла в само сообщение — она и есть новость.
    const sent = app.get(NotificationMockProvider).sent();
    expect(JSON.stringify(sent)).toContain('927000');
  });

  it('торги без победителя доли не создают', async () => {
    const { partnerToken, lotId } = await scene();

    // Ставок не было — торги состоялись, покупателя нет, делить нечего.
    await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
    expect((await finisher.finishLot(lotId)).kind).toBe('FINISHED');

    expect(await prisma.refBonus.count({ where: { lotId } })).toBe(0);
    const after = await bonuses(partnerToken);
    // Лот больше не в торгах, начисления нет — в кабинете пусто.
    expect(after.items).toHaveLength(0);
  });

  it('лот без партнёра доли не порождает', async () => {
    const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
    const lot = await prisma.lot.create({
      data: {
        sellerId: seller.id,
        type: 'REALTY',
        cadastreOrVin: `LOT-${randomUUID()}`,
        startPriceTiyn: 4_500_000_000n,
        status: 'PHASE_III',
      },
      select: { id: true },
    });
    const session = await prisma.auctionSession.create({
      data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
      select: { id: true },
    });
    await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: 4_500_000_000n });

    const buyer = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });
    await bids.place({
      lotId: lot.id,
      bidderId: buyer.id,
      blindCode: 'Инвестор #703',
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
    });
    await outbox.drain();

    await redis.client.hset(state.stateKey(lot.id), 'deadlineMs', String(Date.now() - 1));
    await finisher.finishLot(lot.id);

    // Собственник пришёл сам — комиссию платформа никому не делит.
    expect(await prisma.refBonus.count({ where: { lotId: lot.id } })).toBe(0);
  });
});
