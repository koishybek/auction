import { randomUUID } from 'node:crypto';

import type { EgovLoginResult, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { BidPlacementService, type PlacementResult } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Ограничение частоты ставок (T-031, FR-10).
 *
 * DoD: три клика за 400 мс — один принят, два отклонены с кодом. Человек не
 * кликает чаще двух раз в секунду; всё, что быстрее, это автокликер.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
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

/** Лот в торгах и участник с задатком — всё, кроме лимита, разрешено. */
async function ready(): Promise<{ lot: LotView; buyer: string }> {
  const admin = await devLogin(['ADMIN']);
  const sellerTokens = await egovLogin(randomIin());
  await api()
    .patch(`/api/admin/users/${await userId(sellerTokens)}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'продавец в тесте' })
    .expect(200);

  const created = await api()
    .post('/api/lots')
    .set(...auth(sellerTokens))
    .send({ type: 'REALTY', cadastreOrVin: uniqueVin(), startPriceTenge: 1_000_000 })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(sellerTokens))
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

  const buyer = await userId(await egovLogin(randomIin()));
  await prisma.deposit.create({
    data: { userId: buyer, lotId: lot.id, amountTiyn: 10_000_000n, status: 'ON_SPECIAL_ACCOUNT' },
  });
  return { lot, buyer };
}

function codeOf(result: PlacementResult): string {
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

describe('T-031: лимит частоты ставок', () => {
  it('DoD: три клика за 400 мс — один принят, два отклонены', async () => {
    const { lot, buyer } = await ready();
    const sessionId = randomUUID();
    const results: PlacementResult[] = [];

    /**
     * Сумма считается один раз до кликов, и пауз между ними нет.
     *
     * Первая версия ставила по 150 мс между кликами и спрашивала цену перед
     * каждым — «похоже на человека». На загруженной машине три круга в Redis и
     * PostgreSQL вылезли за 500 мс, окно лимита успело истечь, и третий клик
     * получил SELF_OUTBID вместо RATE_LIMITED. Тест проверял скорость машины,
     * а не лимит. Принята только первая ставка, поэтому сумма остаётся верной
     * для всех трёх попыток.
     */
    const amount = await bids.nextPriceTiyn(lot.id);
    const startedAt = Date.now();

    for (let click = 0; click < 3; click += 1) {
      results.push(
        await placement.place({
          lotId: lot.id,
          userId: buyer,
          expectedAmountTiyn: amount,
          sessionId,
          ip: '203.0.113.7',
        }),
      );
    }

    // Предпосылка проверяется, а не предполагается: не уложились в окно —
    // тест обязан сказать об этом прямо, а не выдать загадочный отказ.
    const elapsed = Date.now() - startedAt;
    expect(elapsed, 'три клика должны уложиться в окно лимита').toBeLessThan(500);

    expect(results.map(codeOf)).toEqual(['ACCEPTED', 'RATE_LIMITED', 'RATE_LIMITED']);

    // Отказ мягкий: участнику говорят, через сколько повторить.
    for (const result of results.slice(1)) {
      expect(result.status === 'REJECTED' && result.retryAfterMs).toBeGreaterThan(0);
      expect(result.status === 'REJECTED' && result.retryAfterMs).toBeLessThanOrEqual(500);
    }

    // Цена сдвинулась ровно на один шаг: отбитые попытки до ядра не дошли.
    expect((await bids.nextPriceTiyn(lot.id)) > 103_000_000n).toBe(true);
  });

  it('после окна ставить снова можно', async () => {
    const { lot, buyer } = await ready();
    const sessionId = randomUUID();
    const other = await userId(await egovLogin(randomIin()));
    await prisma.deposit.create({
      data: { userId: other, lotId: lot.id, amountTiyn: 10_000_000n, status: 'ON_SPECIAL_ACCOUNT' },
    });

    const first = await placement.place({
      lotId: lot.id,
      userId: buyer,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId,
      ip: '203.0.113.7',
    });
    expect(codeOf(first)).toBe('ACCEPTED');

    // Ждём окно. Лимит — задержка, а не блокировка: торги идут дальше.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Перебивает другой участник (себя перебивать нельзя, T-025), затем снова наш.
    await placement.place({
      lotId: lot.id,
      userId: other,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId: randomUUID(),
      ip: '198.51.100.4',
    });

    const again = await placement.place({
      lotId: lot.id,
      userId: buyer,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId,
      ip: '203.0.113.7',
    });
    expect(codeOf(again)).toBe('ACCEPTED');
  });

  it('лимит по адресу не обходится вторым аккаунтом', async () => {
    const { lot, buyer } = await ready();
    const second = await userId(await egovLogin(randomIin()));
    await prisma.deposit.create({
      data: {
        userId: second,
        lotId: lot.id,
        amountTiyn: 10_000_000n,
        status: 'ON_SPECIAL_ACCOUNT',
      },
    });

    const sameIp = '203.0.113.7';
    const first = await placement.place({
      lotId: lot.id,
      userId: buyer,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId: randomUUID(),
      ip: sameIp,
    });
    expect(codeOf(first)).toBe('ACCEPTED');

    // Другая сессия, другой человек — но тот же адрес. Иначе автокликер
    // заводит десять аккаунтов и лимит перестаёт что-либо значить.
    const second2 = await placement.place({
      lotId: lot.id,
      userId: second,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId: randomUUID(),
      ip: sameIp,
    });
    expect(codeOf(second2)).toBe('RATE_LIMITED');
  });

  it('чужой лимит по адресу не сжигает окно сессии', async () => {
    const { lot, buyer } = await ready();
    const sameIp = '203.0.113.7';

    // Сосед по NAT занял окно адреса.
    await redis.client.set(redis.key('rate', 'bid', 'ip', sameIp), '1', 'PX', 500);

    const blocked = await placement.place({
      lotId: lot.id,
      userId: buyer,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId: 'session-под-NAT',
      ip: sameIp,
    });
    expect(codeOf(blocked)).toBe('RATE_LIMITED');

    // Окно сессии при этом не потрачено: как только адрес освободится,
    // человек ставит сразу, а не ждёт ещё полсекунды за чужую вину.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const allowed = await placement.place({
      lotId: lot.id,
      userId: buyer,
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      sessionId: 'session-под-NAT',
      ip: sameIp,
    });
    expect(codeOf(allowed)).toBe('ACCEPTED');
  });

  it('одновременные попытки одной сессии проходят по одной', async () => {
    const { lot, buyer } = await ready();
    const sessionId = randomUUID();
    const next = await bids.nextPriceTiyn(lot.id);

    // Двойной клик мышью: два запроса в одну миллисекунду. Проверка и отметка
    // разъедься они — прошли бы оба.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        placement.place({
          lotId: lot.id,
          userId: buyer,
          expectedAmountTiyn: next,
          sessionId,
          ip: '203.0.113.7',
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => codeOf(r) === 'RATE_LIMITED')).toHaveLength(9);
  });
});
