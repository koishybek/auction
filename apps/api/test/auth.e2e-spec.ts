import type { TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase, databaseNameOf } from './test-db';
import { listenForSupertest } from './test-http';

// getHttpServer() типизирован как any — заворачиваем один раз, а не в каждом тесте.
function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

let app: INestApplication;
let prisma: PrismaService;

async function login(roles: readonly string[]): Promise<TokenPair> {
  const response = await api().post('/api/auth/dev-login').send({ roles }).expect(200);
  return response.body as TokenPair;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  // Та же настройка, что в проде: другой набор фильтров означал бы, что тесты
  // проверяют не то приложение, которое поедет на боевой стенд.
  // Исключение одно — shutdown-хуки: их слушатели сигналов переживают app.close()
  // и не дают процессу vitest завершиться.
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

describe('окружение теста', () => {
  it('работает на отдельной базе, а не на dev', async () => {
    // Если этот тест падает — значит прогон вычищает чужие данные. Он стоит первым.
    const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(rows[0]?.db).toBe('auction_test');
    expect(databaseNameOf(process.env['DATABASE_URL'] ?? '')).toBe('auction_test');
  });
});

describe('вход и доступ по токену', () => {
  it('выдаёт пару токенов и пускает с access-токеном', async () => {
    const tokens = await login(['INVESTOR']);
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresInSec).toBe(900);

    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    expect(me.body).toMatchObject({ roles: ['INVESTOR'], status: 'ACTIVE', egovVerified: false });
  });

  it('без токена не пускает', async () => {
    await api().get('/api/auth/me').expect(401);
  });

  it('с мусором вместо токена не пускает', async () => {
    await api().get('/api/auth/me').set('Authorization', 'Bearer ne-token-garbage').expect(401);
  });

  it('игнорирует токен без схемы Bearer', async () => {
    const tokens = await login(['INVESTOR']);
    await api().get('/api/auth/me').set('Authorization', tokens.accessToken).expect(401);
  });

  it('открытые ручки доступны без токена', async () => {
    await api().get('/api/health').expect(200);
    await api().get('/api/time').expect(200);
  });
});

describe('ролевой гвард', () => {
  it('пускает свою роль', async () => {
    const tokens = await login(['ADMIN']);
    await api()
      .get('/api/auth/admin-only')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('чужую роль отклоняет с 403', async () => {
    // Ровно то, чего требует DoD T-011.
    const tokens = await login(['INVESTOR']);
    const response = await api()
      .get('/api/auth/admin-only')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN_ROLE' });
  });

  it('пускает, если совпала хотя бы одна роль из нескольких', async () => {
    const tokens = await login(['INVESTOR', 'ADMIN']);
    await api()
      .get('/api/auth/admin-only')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('видит смену ролей в БД без перевыпуска токена', async () => {
    // Роли берутся из базы, а не из токена: иначе понижение прав ждало бы
    // истечения access-токена.
    const tokens = await login(['ADMIN']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    await prisma.user.update({
      where: { id: (me.body as { id: string }).id },
      data: { roles: ['INVESTOR'] },
    });

    await api()
      .get('/api/auth/admin-only')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(403);
  });
});

describe('обновление токенов', () => {
  it('выдаёт новую пару и гасит старый refresh', async () => {
    const first = await login(['INVESTOR']);

    const refreshed = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const second = refreshed.body as TokenPair;

    expect(second.refreshToken).not.toBe(first.refreshToken);
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .expect(200);
  });

  it('повторное использование refresh гасит всё семейство сессий', async () => {
    // Признак кражи: законный владелец и вор обновляются по очереди одним токеном.
    // Дешевле заставить человека войти заново, чем оставить вору живую сессию.
    const first = await login(['INVESTOR']);
    const refreshed = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const second = refreshed.body as TokenPair;

    const reuse = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    expect(reuse.body).toMatchObject({ code: 'REFRESH_REUSED' });

    // Сессия, выданная вторым шагом, тоже должна умереть.
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .expect(401);
    await api().post('/api/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
  });

  it('неизвестный refresh отклоняется', async () => {
    const response = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: 'нет-такого-токена' })
      .expect(401);
    expect(response.body).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('просроченный refresh отклоняется', async () => {
    const tokens = await login(['INVESTOR']);
    await prisma.authSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    expect(response.body).toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it('отклоняет лишние поля в теле запроса', async () => {
    // Аналог forbidNonWhitelisted: схема .strict() (задел под QA-04).
    const tokens = await login(['INVESTOR']);
    await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken, isAdmin: true })
      .expect(400);
  });
});

describe('выход', () => {
  it('гасит текущую сессию', async () => {
    const tokens = await login(['INVESTOR']);
    await api()
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(204);

    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);
  });

  it('выход со всех устройств гасит остальные сессии', async () => {
    const first = await login(['INVESTOR']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(200);
    const userId = (me.body as { id: string }).id;

    // Второй вход того же пользователя — как со второго устройства.
    const secondPair = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const second = secondPair.body as TokenPair;

    await api()
      .post('/api/auth/logout-everywhere')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .expect(200);

    const live = await prisma.authSession.count({ where: { userId, revokedAt: null } });
    expect(live).toBe(0);
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .expect(401);
  });
});

describe('блокировка пользователя', () => {
  it('заблокированный не проходит гвард немедленно, не дожидаясь истечения токена', async () => {
    const tokens = await login(['INVESTOR']);
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    await prisma.user.update({
      where: { id: (me.body as { id: string }).id },
      data: { status: 'BLOCKED' },
    });

    const denied = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(403);
    expect(denied.body).toMatchObject({ code: 'USER_BLOCKED' });
  });

  it('заблокированный не может обновить токены', async () => {
    const tokens = await login(['INVESTOR']);
    await prisma.user.updateMany({ data: { status: 'BLOCKED' } });

    const response = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'USER_BLOCKED' });
  });
});

describe('хранение токенов', () => {
  it('refresh-токен не лежит в базе открытым текстом', async () => {
    const tokens = await login(['INVESTOR']);
    const sessions = await prisma.authSession.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.refreshTokenHash).not.toContain(tokens.refreshToken);
    expect(sessions[0]?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
