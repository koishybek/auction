import {
  SMART_HAMMER_TIMER_MS,
  type AuctionStateView,
  type EgovLoginResult,
  type LotView,
  type TokenPair,
} from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;

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
    .send({ sessionId, iin, fio: 'Тестовый Продавец', biometricConfirmed: true })
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

async function sellerLogin(admin: TokenPair): Promise<TokenPair> {
  const tokens = await egovLogin(randomIin());
  await api()
    .patch(`/api/admin/users/${await userId(tokens)}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'выдача роли продавца в тесте' })
    .expect(200);
  return tokens;
}

/** Лот, доведённый до PHASE_II — состояния, из которого открываются торги. */
async function lotReadyForBidding(
  seller: TokenPair,
  admin: TokenPair,
  startPriceTenge = 45_000_000,
): Promise<LotView> {
  const created = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'REALTY', cadastreOrVin: uniqueVin(), startPriceTenge })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(seller))
    .expect(200);
  for (const to of ['PHASE_I', 'PHASE_II'] as const) {
    await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to, reason: 'проводка в тесте' })
      .expect(200);
  }
  return lot;
}

async function startAuction(lotId: string, admin: TokenPair): Promise<AuctionStateView> {
  const response = await api()
    .post(`/api/admin/lots/${lotId}/auction/start`)
    .set(...auth(admin))
    .expect(200);
  return response.body as AuctionStateView;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  state = app.get(AuctionStateService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-022: модель торговой сессии', () => {
  it('DoD: старт сессии даёт согласованное состояние в PostgreSQL и Redis', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin, 45_000_000);

    const view = await startAuction(lot.id, admin);

    // PostgreSQL: сессия существует и знает свой дедлайн.
    const session = await prisma.auctionSession.findFirstOrThrow({ where: { lotId: lot.id } });
    expect(session.status).toBe('RUNNING');
    expect(session.finishedAt).toBeNull();

    // Redis: то же самое состояние, та же сессия.
    const live = await state.read(lot.id);
    expect(live).not.toBeNull();
    expect(live?.sessionId).toBe(session.id);
    expect(live?.status).toBe('RUNNING');
    expect(live?.seq).toBe(0);

    // Сверка: дедлайн в базе — ровно тот, с которым будет сверяться скрипт
    // ставки. Разъедься они, спор о «успел или не успел» решался бы двумя
    // разными ответами.
    expect(session.deadlineAt.getTime()).toBe(live?.deadlineMs);

    // Деньги: в Redis тиыны, наружу тенге, стартовая цена лота.
    expect(live?.priceTiyn).toBe(4_500_000_000n);
    expect(view.currentPriceTenge).toBe(45_000_000);

    // Лот перешёл в торги и показывает текущую цену в каталоге.
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.status).toBe('PHASE_III');
    expect(stored.currentPriceTiyn).toBe(4_500_000_000n);
  });

  it('таймер стартует с 50 секунд и отдаётся остатком, а не дедлайном', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);

    const view = await startAuction(lot.id, admin);

    expect(view.timeRemainingMs).toBeLessThanOrEqual(SMART_HAMMER_TIMER_MS);
    expect(view.timeRemainingMs).toBeGreaterThan(SMART_HAMMER_TIMER_MS - 2_000);

    // Абсолютного дедлайна в ответе нет: часы клиента в механике не участвуют.
    expect(Object.keys(view)).not.toContain('deadlineAt');
    expect(Object.keys(view)).not.toContain('deadlineMs');
  });

  it('остаток убывает по серверным часам', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);

    const first = await startAuction(lot.id, admin);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await api().get(`/api/lots/${lot.id}/auction`).expect(200);

    const later = second.body as AuctionStateView;
    expect(later.timeRemainingMs).toBeLessThan(first.timeRemainingMs);
    expect(first.timeRemainingMs - later.timeRemainingMs).toBeGreaterThanOrEqual(900);
  });

  it('повторный старт по тому же лоту отклоняется', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);

    await startAuction(lot.id, admin);

    // Второй старт обнулил бы цену уже идущих торгов.
    const conflict = await api()
      .post(`/api/admin/lots/${lot.id}/auction/start`)
      .set(...auth(admin))
      .expect(409);
    expect((conflict.body as { code: string }).code).toBe('SESSION_ALREADY_RUNNING');
  });

  it('в PHASE_III нельзя перевести общей ручкой смены статуса', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);

    // Иначе лот выглядел бы торгующимся, а поставить на него было бы нельзя.
    const refused = await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to: 'PHASE_III', reason: 'попытка в обход старта торгов' })
      .expect(409);
    expect((refused.body as { code: string }).code).toBe('USE_AUCTION_START');

    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.status).toBe('PHASE_II');
    expect(await state.read(lot.id)).toBeNull();
  });

  it('потерянное состояние Redis восстанавливается из PostgreSQL', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);
    const started = await startAuction(lot.id, admin);

    // Перезапуск Redis посреди торгов: ключ исчез, лот в PHASE_III остался.
    await state.drop(lot.id);
    expect(await state.read(lot.id)).toBeNull();

    const restored = await api().get(`/api/lots/${lot.id}/auction`).expect(200);
    const view = restored.body as AuctionStateView;

    expect(view.sessionId).toBe(started.sessionId);
    expect(view.currentPriceTenge).toBe(started.currentPriceTenge);
    expect(view.seq).toBe(0);

    // Дедлайн восстановлен из базы — торги не продлились на ровном месте.
    const session = await prisma.auctionSession.findFirstOrThrow({ where: { lotId: lot.id } });
    const live = await state.read(lot.id);
    expect(live?.deadlineMs).toBe(session.deadlineAt.getTime());
  });

  it('по лоту без торгов состояние не выдумывается', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);

    const missing = await api().get(`/api/lots/${lot.id}/auction`).expect(404);
    expect((missing.body as { code: string }).code).toBe('SESSION_NOT_FOUND');
  });

  it('торги открывает только администратор', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotReadyForBidding(seller, admin);

    await api()
      .post(`/api/admin/lots/${lot.id}/auction/start`)
      .set(...auth(seller))
      .expect(403);
    await api().post(`/api/admin/lots/${lot.id}/auction/start`).expect(401);
  });
});
