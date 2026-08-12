import type { EgovLoginResult, LotListView, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { LotViewsService } from '../src/lots/lot-views.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let views: LotViewsService;

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

/** Опубликованный лот: просмотры считаются только у того, что видно публике. */
async function publishedLot(seller: TokenPair, admin: TokenPair): Promise<LotView> {
  const created = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'REALTY', cadastreOrVin: '20-317-077-1058', startPriceTenge: 45_000_000 })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(seller))
    .expect(200);
  await api()
    .patch(`/api/admin/lots/${lot.id}/status`)
    .set(...auth(admin))
    .send({ to: 'PHASE_I', reason: 'публикация в тесте' })
    .expect(200);

  return lot;
}

/** Посетитель-аноним: узнаётся по адресу и User-Agent, разный агент — разный человек. */
async function viewAs(lotId: string, userAgent: string): Promise<boolean> {
  const response = await api()
    .post(`/api/lots/${lotId}/view`)
    .set('User-Agent', userAgent)
    .expect(200);
  return (response.body as { counted: boolean }).counted;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  views = app.get(LotViewsService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-017: счётчик просмотров лота', () => {
  it('повторный просмотр в течение часа не увеличивает счётчик', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);

    // DoD: первый заход считается, второй тем же посетителем — нет.
    expect(await viewAs(lot.id, 'Mozilla/5.0 (visitor-one)')).toBe(true);
    expect(await viewAs(lot.id, 'Mozilla/5.0 (visitor-one)')).toBe(false);
    expect(await viewAs(lot.id, 'Mozilla/5.0 (visitor-one)')).toBe(false);

    await views.flush();
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.viewsCount).toBe(1);
  });

  it('разные посетители считаются по отдельности', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);

    expect(await viewAs(lot.id, 'browser-A')).toBe(true);
    expect(await viewAs(lot.id, 'browser-B')).toBe(true);
    expect(await viewAs(lot.id, 'browser-C')).toBe(true);
    expect(await viewAs(lot.id, 'browser-B')).toBe(false);

    await views.flush();
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.viewsCount).toBe(3);
  });

  it('авторизованный узнаётся по себе, а не по браузеру', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);
    const investor = await devLogin(['INVESTOR']);

    // Один и тот же человек с двух устройств — всё ещё один просмотр за час.
    const first = await api()
      .post(`/api/lots/${lot.id}/view`)
      .set(...auth(investor))
      .set('User-Agent', 'phone-device')
      .expect(200);
    const second = await api()
      .post(`/api/lots/${lot.id}/view`)
      .set(...auth(investor))
      .set('User-Agent', 'laptop-device')
      .expect(200);

    expect((first.body as { counted: boolean }).counted).toBe(true);
    expect((second.body as { counted: boolean }).counted).toBe(false);
  });

  it('заходы продавца на собственный лот не считаются', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);

    const response = await api()
      .post(`/api/lots/${lot.id}/view`)
      .set(...auth(seller))
      .expect(200);

    expect((response.body as { counted: boolean }).counted).toBe(false);
    await views.flush();
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.viewsCount).toBe(0);
  });

  it('DoD: цифра видна продавцу и не видна посторонним', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);

    await viewAs(lot.id, 'random-visitor');

    // Продавцу — актуальное число, ещё до сброса в БД.
    const mine = await api()
      .get('/api/lots/my')
      .set(...auth(seller))
      .expect(200);
    const own = (mine.body as LotListView).items.find((item) => item.id === lot.id);
    expect(own?.viewsCount).toBe(1);

    const card = await api()
      .get(`/api/lots/${lot.id}`)
      .set(...auth(seller))
      .expect(200);
    expect((card.body as LotView).viewsCount).toBe(1);

    // Постороннему и анониму цифра не положена вовсе.
    const investor = await devLogin(['INVESTOR']);
    const foreign = await api()
      .get(`/api/lots/${lot.id}`)
      .set(...auth(investor))
      .expect(200);
    expect((foreign.body as LotView).viewsCount).toBeNull();

    const anonymous = await api().get(`/api/lots/${lot.id}`).expect(200);
    expect((anonymous.body as LotView).viewsCount).toBeNull();

    const catalog = await api().get('/api/lots').expect(200);
    for (const item of (catalog.body as LotListView).items) {
      expect(item.viewsCount).toBeNull();
    }
  });

  it('сброс переносит накопленное в БД и не выдаёт лот за изменённый', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);

    const before = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    await viewAs(lot.id, 'visitor-before-flush');

    expect(await views.flush()).toBe(1);
    const after = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(after.viewsCount).toBe(1);

    // Просмотр карточки — не правка лота: updated_at обязан остаться прежним,
    // иначе продавец увидит «изменён минуту назад» на ровном месте.
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());

    // Второй сброс подряд — пустой: накопленное забирается ровно один раз.
    expect(await views.flush()).toBe(0);
    const twice = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(twice.viewsCount).toBe(1);
  });

  it('чужой черновик не посмотреть и не накрутить', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const draft = await api()
      .post('/api/lots')
      .set(...auth(seller))
      .send({ type: 'VEHICLE', cadastreOrVin: 'XTA210740R1234567', startPriceTenge: 3_000_000 })
      .expect(201);
    const lotId = (draft.body as LotView).id;

    // 404, а не 403: существование чужого черновика не подтверждаем.
    await api().post(`/api/lots/${lotId}/view`).expect(404);

    await views.flush();
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(stored.viewsCount).toBe(0);
  });

  it('одновременные заходы одного посетителя дают ровно один просмотр', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await publishedLot(seller, admin);

    // Проверка атомарности Lua-скрипта: без неё «проверить и посчитать»
    // разъезжается на два шага, и параллельные заходы считаются дважды.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => viewAs(lot.id, 'impatient-visitor')),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    await views.flush();
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.viewsCount).toBe(1);
  });
});
