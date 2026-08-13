import type { EgovLoginResult, LotListView, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RegistryMockProvider } from '../src/integrations/registry/registry.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

let app: INestApplication;
let prisma: PrismaService;
let registryMock: RegistryMockProvider;

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

/** Случайный ИИН: каждый вызов — новый пользователь. */
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

/**
 * Верифицированный продавец: eGov-вход (даёт INVESTOR + верификацию),
 * затем админ выдаёт роль SELLER — единственный путь стать продавцом.
 */
async function sellerLogin(admin: TokenPair): Promise<TokenPair> {
  const tokens = await egovLogin(randomIin());
  await api()
    .patch(`/api/admin/users/${await userId(tokens)}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'выдача роли продавца в тесте' })
    .expect(200);
  return tokens;
}

async function createDraft(
  seller: TokenPair,
  cadastreOrVin = '20-317-077-1058',
  startPriceTenge = 45_000_000,
): Promise<LotView> {
  const response = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'REALTY', cadastreOrVin, startPriceTenge })
    .expect(201);
  return response.body as LotView;
}

/** Провести лот черновик → нужный статус силами админа. */
async function driveTo(
  lotId: string,
  seller: TokenPair,
  admin: TokenPair,
  target: 'MODERATION' | 'PHASE_I' | 'PHASE_II' | 'PHASE_III',
): Promise<void> {
  await api()
    .post(`/api/lots/${lotId}/submit`)
    .set(...auth(seller))
    .expect(200);
  if (target === 'MODERATION') return;

  for (const status of ['PHASE_I', 'PHASE_II'] as const) {
    await api()
      .patch(`/api/admin/lots/${lotId}/status`)
      .set(...auth(admin))
      .send({ to: status, reason: 'тестовая проводка' })
      .expect(200);
    if (status === target) return;
  }

  // PHASE_III выставляется только вместе с торговой сессией (T-022): статус
  // «идут торги» без цены, дедлайна и seq — лот, на который нельзя поставить.
  await api()
    .post(`/api/admin/lots/${lotId}/auction/start`)
    .set(...auth(admin))
    .expect(200);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);
  prisma = app.get(PrismaService);
  registryMock = app.get(RegistryMockProvider);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  registryMock.reset();
  await cleanDatabase(prisma);
});

describe('T-015: CRUD лотов', () => {
  it('продавец создаёт черновик, цена хранится в тиынах, наружу — тенге', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);

    expect(lot.status).toBe('DRAFT');
    expect(lot.startPriceTenge).toBe(45_000_000);

    const raw = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(raw.startPriceTiyn).toBe(4_500_000_000n); // ×100, bigint
  });

  it('инвестор лот создать не может', async () => {
    const investor = await devLogin(['INVESTOR']);
    await api()
      .post('/api/lots')
      .set(...auth(investor))
      .send({ type: 'REALTY', cadastreOrVin: '20-317-077-1058', startPriceTenge: 1000 })
      .expect(403);
  });

  it('дробная и отрицательная цена отклоняются', async () => {
    const seller = await devLogin(['SELLER']);
    for (const startPriceTenge of [100.5, -5, 0]) {
      await api()
        .post('/api/lots')
        .set(...auth(seller))
        .send({ type: 'REALTY', cadastreOrVin: '20-317-077-1058', startPriceTenge })
        .expect(400);
    }
  });

  it('черновик правится, после отправки на модерацию — заморожен', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);

    const updated = await api()
      .patch(`/api/lots/${lot.id}`)
      .set(...auth(seller))
      .send({ startPriceTenge: 50_000_000 })
      .expect(200);
    expect((updated.body as LotView).startPriceTenge).toBe(50_000_000);

    await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(200);

    const frozen = await api()
      .patch(`/api/lots/${lot.id}`)
      .set(...auth(seller))
      .send({ startPriceTenge: 60_000_000 })
      .expect(409);
    expect(frozen.body).toMatchObject({ code: 'LOT_NOT_EDITABLE' });
  });

  it('чужой черновик не читается, не правится и не сабмитится', async () => {
    const seller = await devLogin(['SELLER']);
    const other = await devLogin(['SELLER']);
    const lot = await createDraft(seller);

    // Чтение чужого черновика — 404, само существование не подтверждаем.
    await api()
      .get(`/api/lots/${lot.id}`)
      .set(...auth(other))
      .expect(404);
    // Правка и сабмит — 403: тут знание о существовании неизбежно.
    await api()
      .patch(`/api/lots/${lot.id}`)
      .set(...auth(other))
      .send({ startPriceTenge: 1 })
      .expect(403);
    await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(other))
      .expect(403);
  });

  it('аноним видит опубликованный лот, но не черновик', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);

    await api().get(`/api/lots/${lot.id}`).expect(404); // черновик для анонима не существует
    await api()
      .get(`/api/lots/${lot.id}`)
      .set(...auth(seller))
      .expect(200); // владелец видит

    await driveTo(lot.id, seller, admin, 'PHASE_I');
    const publicView = await api().get(`/api/lots/${lot.id}`).expect(200);
    expect((publicView.body as LotView).status).toBe('PHASE_I');
  });

  it('каталог отдаёт только публичные статусы', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    await createDraft(seller); // остаётся черновиком
    const published = await createDraft(seller, '20-317-077-2222');
    await driveTo(published.id, seller, admin, 'PHASE_I');

    const catalog = await api().get('/api/lots').expect(200);
    const body = catalog.body as LotListView;
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe(published.id);
  });

  it('свои лоты продавец видит все, включая черновики', async () => {
    const seller = await devLogin(['SELLER']);
    await createDraft(seller);
    await createDraft(seller, '20-317-077-3333');

    const mine = await api()
      .get('/api/lots/my')
      .set(...auth(seller))
      .expect(200);
    expect((mine.body as LotListView).total).toBe(2);
  });
});

describe('T-015: статусная машина через API', () => {
  it('полный жизненный цикл: DRAFT → … → PHASE_III', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);

    await driveTo(lot.id, seller, admin, 'PHASE_III');

    const final = await api().get(`/api/lots/${lot.id}`).expect(200);
    expect((final.body as LotView).status).toBe('PHASE_III');
  });

  it('DoD: недопустимый переход = 409 с причиной', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);

    const jump = await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to: 'FINISHED', reason: 'прыжок через фазы' })
      .expect(409);
    expect(jump.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(JSON.stringify(jump.body)).toMatch(/не существует/);
  });

  it('админ не может завершить торги руками — только система', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);
    await driveTo(lot.id, seller, admin, 'PHASE_III');

    const finish = await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to: 'FINISHED', reason: 'ручное завершение' })
      .expect(409);
    expect(JSON.stringify(finish.body)).toMatch(/недоступен роли/);
  });

  it('повторный submit того же лота — 409', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);
    await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(200);
    await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(409);
  });

  it('каждый переход оставляет запись в audit_log', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller);

    const before = await prisma.auditLog.count({ where: { action: 'lot.transition' } });
    await driveTo(lot.id, seller, admin, 'PHASE_II'); // submit + 2 админских
    const after = await prisma.auditLog.count({ where: { action: 'lot.transition' } });
    expect(after - before).toBe(3);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'lot.transition', entityId: lot.id },
      orderBy: { serverTs: 'desc' },
    });
    expect(entry?.payloadJson).toMatchObject({ from: 'PHASE_I', to: 'PHASE_II', asRole: 'ADMIN' });
  });

  it('несуществующий лот — 404', async () => {
    const admin = await devLogin(['ADMIN']);
    await api()
      .patch(`/api/admin/lots/${crypto.randomUUID()}/status`)
      .set(...auth(admin))
      .send({ to: 'PHASE_I', reason: 'нет лота' })
      .expect(404);
  });
});

describe('T-019: проверка КИСИП/ЕРД при подаче лота', () => {
  it('неверифицированный продавец не может подать лот — реестр проверять нечем', async () => {
    const seller = await devLogin(['SELLER']); // dev-вход = без eGov
    const lot = await createDraft(seller);
    const response = await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(403);
    expect(response.body).toMatchObject({ code: 'EGOV_NOT_VERIFIED' });
  });

  it('DoD: HAS_RESTRICTION=true блокирует публикацию, лот остаётся в DRAFT', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller, 'ARREST-20-317');

    const response = await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(409);
    expect(response.body).toMatchObject({ code: 'REGISTRY_RESTRICTION' });

    const raw = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(raw.status).toBe('DRAFT');
  });

  it('каждая проверка пишется в registry_checks — и чистая, и с ограничением', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);

    const clean = await createDraft(seller, '20-317-077-5555');
    await api()
      .post(`/api/lots/${clean.id}/submit`)
      .set(...auth(seller))
      .expect(200);

    const arrested = await createDraft(seller, 'ARREST-1111');
    await api()
      .post(`/api/lots/${arrested.id}/submit`)
      .set(...auth(seller))
      .expect(409);

    const cleanCheck = await prisma.registryCheck.findFirst({ where: { lotId: clean.id } });
    const arrestedCheck = await prisma.registryCheck.findFirst({ where: { lotId: arrested.id } });
    expect(cleanCheck?.hasRestriction).toBe(false);
    expect(arrestedCheck?.hasRestriction).toBe(true);
    // Сырой ответ реестра сохранён для разборов.
    expect(arrestedCheck?.payloadJson).toMatchObject({ provider: 'mock' });
  });

  it('управляемый мок: ограничение задаётся и снимается на конкретный объект', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await createDraft(seller, '20-999-001-0001');

    registryMock.setRestriction('20-999-001-0001', ['Залог банка']);
    const denied = await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(409);
    expect(JSON.stringify(denied.body)).toContain('Залог банка');

    registryMock.setRestriction('20-999-001-0001', []);
    await api()
      .post(`/api/lots/${lot.id}/submit`)
      .set(...auth(seller))
      .expect(200);
  });
});
