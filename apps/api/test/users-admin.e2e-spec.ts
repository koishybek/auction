import type { EgovLoginResult, MyProfileView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

let app: INestApplication;
let prisma: PrismaService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

const IIN = '900101300123';
const FIO = 'Мұхаметқали Әбдіраманұлы Серікбаев';

async function devLogin(roles: readonly string[]): Promise<TokenPair> {
  const response = await api().post('/api/auth/dev-login').send({ roles }).expect(200);
  return response.body as TokenPair;
}

/** Полный eGov-вход: единственный путь получить верифицированного пользователя. */
async function egovLogin(iin = IIN, fio = FIO): Promise<TokenPair> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin, fio, biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');
  return result.tokens;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
});

describe('T-013: профиль и статусы верификации', () => {
  it('верифицированный видит ФИО и маскированный ИИН', async () => {
    const tokens = await egovLogin();
    const response = await api()
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    const profile = response.body as MyProfileView;
    expect(profile.egovVerified).toBe(true);
    expect(profile.verifiedAt).not.toBeNull();
    expect(profile.fio).toBe(FIO);
    expect(profile.iinMasked).toBe('900101******');
    // Полного ИИН в ответе нет нигде.
    expect(JSON.stringify(response.body)).not.toContain(IIN);
  });

  it('dev-пользователь без eGov видит профиль без ПДн и без верификации', async () => {
    const tokens = await devLogin(['INVESTOR']);
    const response = await api()
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    const profile = response.body as MyProfileView;
    expect(profile.egovVerified).toBe(false);
    expect(profile.fio).toBeNull();
    expect(profile.iinMasked).toBeNull();
  });

  it('неверифицированный не допускается к задатку (DoD T-013)', async () => {
    const tokens = await devLogin(['INVESTOR']);
    const response = await api()
      .get('/api/users/me/deposit-access')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(403);
    expect(response.body).toMatchObject({ code: 'EGOV_NOT_VERIFIED' });
  });

  it('верифицированный допускается к задатку', async () => {
    const tokens = await egovLogin();
    const response = await api()
      .get('/api/users/me/deposit-access')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    expect(response.body).toMatchObject({ allowed: true });
  });

  it('верификация действует сразу после eGov-входа в той же сессии dev-пользователя', async () => {
    // Сценарий смешанного пути: человек начал как dev (неверифицированный),
    // затем прошёл eGov. Старый токен привязан к старому пользователю и не
    // становится верифицированным — верификация не перетекает между аккаунтами.
    const devTokens = await devLogin(['INVESTOR']);
    await egovLogin();
    await api()
      .get('/api/users/me/deposit-access')
      .set('Authorization', `Bearer ${devTokens.accessToken}`)
      .expect(403);
  });
});

describe('T-014: админ-минимум', () => {
  it('админ видит список с ФИО, маской ИИН и числом сессий', async () => {
    await egovLogin();
    const admin = await devLogin(['ADMIN']);

    const response = await api()
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const body = response.body as {
      items: { fio: string | null; iinMasked: string | null; sessionsActive: number }[];
      total: number;
    };
    expect(body.total).toBe(2); // инвестор + сам админ
    const verified = body.items.find((item) => item.fio !== null);
    expect(verified?.fio).toBe(FIO);
    expect(verified?.iinMasked).toBe('900101******');
    expect(JSON.stringify(body)).not.toContain(IIN);
  });

  it('не-админа в админку не пускает', async () => {
    const tokens = await egovLogin();
    await api()
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(403);
  });

  it('фильтр по статусу и пагинация работают', async () => {
    const investor = await egovLogin();
    const admin = await devLogin(['ADMIN']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${investor.accessToken}`)
      .expect(200);

    await api()
      .patch(`/api/admin/users/${(me.body as { id: string }).id}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'BLOCKED', reason: 'подозрение на мультиаккаунт' })
      .expect(200);

    const blocked = await api()
      .get('/api/admin/users?status=BLOCKED')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect((blocked.body as { total: number }).total).toBe(1);

    const paged = await api()
      .get('/api/admin/users?page=2&pageSize=1')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect((paged.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('DoD T-014: блокировка выкидывает пользователя немедленно', async () => {
    const investor = await egovLogin();
    const admin = await devLogin(['ADMIN']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${investor.accessToken}`)
      .expect(200);
    const userId = (me.body as { id: string }).id;

    const block = await api()
      .patch(`/api/admin/users/${userId}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'BLOCKED', reason: 'нарушение правил торгов' })
      .expect(200);
    expect(block.body).toMatchObject({ status: 'BLOCKED', sessionsRevoked: 1 });

    // Auth-гвард отбивает сразу: и access, и refresh мертвы.
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${investor.accessToken}`)
      .expect(401); // сессия погашена → SESSION_REVOKED раньше проверки статуса
    await api().post('/api/auth/refresh').send({ refreshToken: investor.refreshToken }).expect(401);
  });

  it('разблокировка возвращает возможность входа, но не воскрешает сессии', async () => {
    const investor = await egovLogin();
    const admin = await devLogin(['ADMIN']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${investor.accessToken}`)
      .expect(200);
    const userId = (me.body as { id: string }).id;

    await api()
      .patch(`/api/admin/users/${userId}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'BLOCKED', reason: 'проверка' })
      .expect(200);
    await api()
      .patch(`/api/admin/users/${userId}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'ACTIVE', reason: 'ошибочная блокировка' })
      .expect(200);

    // Старый токен мёртв навсегда, но новый вход работает.
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${investor.accessToken}`)
      .expect(401);
    const again = await egovLogin();
    await api().get('/api/auth/me').set('Authorization', `Bearer ${again.accessToken}`).expect(200);
  });

  it('блокировка и просмотр списка оставляют след в audit_log', async () => {
    const investor = await egovLogin();
    const admin = await devLogin(['ADMIN']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${investor.accessToken}`)
      .expect(200);
    const userId = (me.body as { id: string }).id;

    const before = await prisma.auditLog.count();
    await api()
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await api()
      .patch(`/api/admin/users/${userId}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'BLOCKED', reason: 'тест аудита' })
      .expect(200);

    const after = await prisma.auditLog.count();
    expect(after - before).toBe(2);

    const blockEntry = await prisma.auditLog.findFirst({
      where: { action: 'admin.user.block', entityId: userId },
      orderBy: { serverTs: 'desc' },
    });
    expect(blockEntry?.payloadJson).toMatchObject({ reason: 'тест аудита', sessionsRevoked: 1 });
  });

  it('блокировка несуществующего пользователя — 404, не 500', async () => {
    const admin = await devLogin(['ADMIN']);
    await api()
      .patch(`/api/admin/users/${crypto.randomUUID()}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'BLOCKED', reason: 'нет такого' })
      .expect(404);
  });

  it('причина блокировки обязательна', async () => {
    const admin = await devLogin(['ADMIN']);
    await api()
      .patch(`/api/admin/users/${crypto.randomUUID()}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'BLOCKED' })
      .expect(400);
  });
});
