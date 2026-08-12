import type { EgovLoginResult, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidPlacementService, type PlacementResult } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';

/**
 * Право поставить (T-025).
 *
 * Матрица отказов из DoD: NO_DEPOSIT, SELF_OUTBID, TIMER_EXPIRED — плюс
 * верификация, блокировка и запрет продавцу торговать своим лотом. Каждый
 * случай воспроизводится, а не проверяется рассуждением.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(tokens: TokenPair): [string, string] {
  return ['Authorization', `Bearer ${tokens.accessToken}`];
}

async function devLogin(roles: readonly string[]): Promise<TokenPair> {
  const response = await api().post('/api/auth/dev-login').send({ roles }).expect(200);
  return response.body as TokenPair;
}

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

function uniqueVin(): string {
  return `VIN${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
}

async function egovLogin(iin: string): Promise<TokenPair> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin, fio: 'Тестовый Участник', biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');
  return result.tokens;
}

async function userId(tokens: TokenPair): Promise<string> {
  const me = await api()
    .get('/api/auth/me')
    .set(...auth(tokens))
    .expect(200);
  return (me.body as { id: string }).id;
}

/** Верифицированный инвестор: eGov-вход даёт роль INVESTOR и верификацию. */
async function investor(): Promise<string> {
  return userId(await egovLogin(randomIin()));
}

async function seller(admin: TokenPair): Promise<{ tokens: TokenPair; id: string }> {
  const tokens = await egovLogin(randomIin());
  const id = await userId(tokens);
  await api()
    .patch(`/api/admin/users/${id}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'выдача роли продавца в тесте' })
    .expect(200);
  return { tokens, id };
}

/** Лот с открытыми торгами. Стартовая цена 1 000 000 ₸ — шаг ровно 30 000 ₸. */
async function lotInAuction(): Promise<{ lot: LotView; sellerId: string; admin: TokenPair }> {
  const admin = await devLogin(['ADMIN']);
  const owner = await seller(admin);

  const created = await api()
    .post('/api/lots')
    .set(...auth(owner.tokens))
    .send({ type: 'REALTY', cadastreOrVin: uniqueVin(), startPriceTenge: 1_000_000 })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(owner.tokens))
    .expect(200);
  for (const to of ['PHASE_I', 'PHASE_II'] as const) {
    await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to, reason: 'проводка в тесте' })
      .expect(200);
  }
  await api()
    .post(`/api/admin/lots/${lot.id}/auction/start`)
    .set(...auth(admin))
    .expect(200);

  return { lot, sellerId: owner.id, admin };
}

/** Задаток 10 % от стартовой цены на спецсчёте — условие допуска к ставкам. */
async function payDeposit(userId: string, lot: LotView): Promise<void> {
  await prisma.deposit.create({
    data: {
      userId,
      lotId: lot.id,
      amountTiyn: (BigInt(lot.startPriceTenge) * 100n) / 10n,
      status: 'ON_SPECIAL_ACCOUNT',
    },
  });
}

async function bid(
  lotId: string,
  userId: string,
  blindCode = 'Инвестор #704',
): Promise<PlacementResult> {
  return placement.place({
    lotId,
    userId,
    blindCode,
    expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
  });
}

function codeOf(result: PlacementResult): string {
  return result.status === 'REJECTED' ? result.code : 'ACCEPTED';
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
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

describe('T-025: право поставить', () => {
  it('участник с задатком на спецсчёте ставит успешно', async () => {
    const { lot } = await lotInAuction();
    const buyer = await investor();
    await payDeposit(buyer, lot);

    const result = await bid(lot.id, buyer);
    expect(codeOf(result)).toBe('ACCEPTED');
    expect(result.status === 'ACCEPTED' && result.priceTenge).toBe(1_030_000);
  });

  it('DoD: без задатка — NO_DEPOSIT', async () => {
    const { lot } = await lotInAuction();
    const buyer = await investor();

    // Задаток не внесён вовсе.
    expect(codeOf(await bid(lot.id, buyer))).toBe('NO_DEPOSIT');

    // Цена не сдвинулась: отказ произошёл до атомарного ядра.
    expect((await state.read(lot.id))?.seq).toBe(0);
  });

  it('задаток не в статусе ON_SPECIAL_ACCOUNT ставку не открывает', async () => {
    const { lot } = await lotInAuction();
    const buyer = await investor();

    // Оплачен, но ещё не на спецсчёте — деньги не там, где нужно.
    await prisma.deposit.create({
      data: { userId: buyer, lotId: lot.id, amountTiyn: 10_000_000n, status: 'HELD' },
    });
    expect(codeOf(await bid(lot.id, buyer))).toBe('NO_DEPOSIT');

    // Как только задаток на спецсчёте — ставка проходит.
    await prisma.deposit.update({
      where: { userId_lotId: { userId: buyer, lotId: lot.id } },
      data: { status: 'ON_SPECIAL_ACCOUNT' },
    });
    expect(codeOf(await bid(lot.id, buyer))).toBe('ACCEPTED');
  });

  it('DoD: перебить собственную ставку нельзя — SELF_OUTBID', async () => {
    const { lot } = await lotInAuction();
    const first = await investor();
    const second = await investor();
    await payDeposit(first, lot);
    await payDeposit(second, lot);

    expect(codeOf(await bid(lot.id, first))).toBe('ACCEPTED');
    // Он же сразу вторично: цена ушла бы вверх без конкуренции.
    expect(codeOf(await bid(lot.id, first))).toBe('SELF_OUTBID');

    // Другой участник перебивает свободно, и тогда первому снова можно.
    expect(codeOf(await bid(lot.id, second))).toBe('ACCEPTED');
    expect(codeOf(await bid(lot.id, first))).toBe('ACCEPTED');

    const live = await state.read(lot.id);
    expect(live?.seq).toBe(3);
  });

  it('запрет на self-outbid держится при одновременных попытках', async () => {
    const { lot } = await lotInAuction();
    const buyer = await investor();
    await payDeposit(buyer, lot);

    // Двойной клик — именно так обходилась бы проверка, стоящая до
    // атомарного скрипта: оба запроса прочитали бы состояние без его ставки.
    const next = await bids.nextPriceTiyn(lot.id);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        placement.place({
          lotId: lot.id,
          userId: buyer,
          blindCode: 'Инвестор #704',
          expectedAmountTiyn: next,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect((await state.read(lot.id))?.seq).toBe(1);
  });

  it('DoD: после истечения таймера — TIMER_EXPIRED', async () => {
    const { lot } = await lotInAuction();
    const buyer = await investor();
    await payDeposit(buyer, lot);

    const session = await prisma.auctionSession.findFirstOrThrow({ where: { lotId: lot.id } });
    const next = await bids.nextPriceTiyn(lot.id);

    // 50 секунд тишины: дедлайн в прошлом.
    await state.drop(lot.id);
    await state.restore({
      lotId: lot.id,
      sessionId: session.id,
      status: 'RUNNING',
      priceTiyn: 100_000_000n,
      seq: 0,
      deadlineMs: Date.now() - 1_000,
    });

    const result = await placement.place({
      lotId: lot.id,
      userId: buyer,
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: next,
    });
    expect(codeOf(result)).toBe('TIMER_EXPIRED');
  });

  it('без верификации eGov ставка не принимается', async () => {
    const { lot } = await lotInAuction();
    // dev-login даёт роль, но не верификацию — ровно то состояние, в котором
    // человек зарегистрировался и до eGov не дошёл.
    const unverified = await userId(await devLogin(['INVESTOR']));
    await payDeposit(unverified, lot);

    expect(codeOf(await bid(lot.id, unverified))).toBe('EGOV_NOT_VERIFIED');
  });

  it('заблокированный участник не ставит, даже с задатком', async () => {
    const { lot, admin } = await lotInAuction();
    const buyer = await investor();
    await payDeposit(buyer, lot);
    expect(codeOf(await bid(lot.id, buyer))).toBe('ACCEPTED');

    await api()
      .patch(`/api/admin/users/${buyer}/status`)
      .set(...auth(admin))
      .send({ status: 'BLOCKED', reason: 'блокировка в тесте' })
      .expect(200);

    // Блокировка действует немедленно: право читается из БД, а не из токена.
    expect(codeOf(await bid(lot.id, buyer))).toBe('USER_BLOCKED');
  });

  it('продавец не торгует собственным лотом', async () => {
    const { lot, sellerId } = await lotInAuction();
    await prisma.deposit.create({
      data: {
        userId: sellerId,
        lotId: lot.id,
        amountTiyn: 10_000_000n,
        status: 'ON_SPECIAL_ACCOUNT',
      },
    });

    // Разгон цены собственного лота — подлог, а не участие. Проверка на
    // сервере, а не только скрытая кнопка (DoD T-041).
    expect(codeOf(await bid(lot.id, sellerId))).toBe('SELLER_OWN_LOT');
    expect((await state.read(lot.id))?.seq).toBe(0);
  });

  it('по лоту без торгов отказ приходит от ядра, а не от прав', async () => {
    const { lot } = await lotInAuction();
    const buyer = await investor();
    await payDeposit(buyer, lot);

    const next = await bids.nextPriceTiyn(lot.id);
    await state.drop(lot.id);
    await prisma.auctionSession.updateMany({
      where: { lotId: lot.id },
      data: { status: 'FINISHED' },
    });

    const result = await placement.place({
      lotId: lot.id,
      userId: buyer,
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: next,
    });
    expect(codeOf(result)).toBe('NO_SESSION');
  });
});
