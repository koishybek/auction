import type { EgovLoginResult, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

let app: INestApplication;
let prisma: PrismaService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

const IIN = '900101300123';
const FIO = 'Мұхаметқали Әбдіраманұлы Серікбаев';

async function initSession(): Promise<string> {
  const response = await api().post('/api/auth/egov/init').expect(200);
  return (response.body as { sessionId: string }).sessionId;
}

async function approve(sessionId: string, iin = IIN, fio = FIO): Promise<void> {
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin, fio, biometricConfirmed: true })
    .expect(200);
}

async function complete(sessionId: string): Promise<EgovLoginResult> {
  const response = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  return response.body as EgovLoginResult;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.authSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('eGov-флоу: init → approve → complete → JWT', () => {
  it('полный цикл выдаёт рабочие токены и верифицированного пользователя', async () => {
    const sessionId = await initSession();

    // До подтверждения — PENDING, токенов нет.
    expect(await complete(sessionId)).toEqual({ status: 'PENDING' });

    await approve(sessionId);
    const result = await complete(sessionId);
    if (result.status !== 'COMPLETED') {
      throw new Error(`ожидали COMPLETED, получили ${result.status}`);
    }

    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${result.tokens.accessToken}`)
      .expect(200);
    expect(me.body).toMatchObject({
      roles: ['INVESTOR'],
      status: 'ACTIVE',
      egovVerified: true, // вход через eGov = верификация (T-013 завязан на это поле)
    });
  });

  it('ПДн из eGov ложатся в базу зашифрованными, с blind index', async () => {
    const sessionId = await initSession();
    await approve(sessionId);
    await complete(sessionId);

    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    const user = users[0];
    // Открытого текста в базе нет.
    expect(user?.fioEnc).not.toBeNull();
    expect(Buffer.from(user?.fioEnc ?? []).toString('utf8')).not.toContain('Серікбаев');
    expect(Buffer.from(user?.iinEnc ?? []).toString('utf8')).not.toContain(IIN);
    // Индекс — hex от HMAC, не сам ИИН.
    expect(user?.iinBlindIdx).toMatch(/^[0-9a-f]{64}$/);
    expect(user?.iinBlindIdx).not.toContain(IIN);
  });

  it('повторный вход с тем же ИИН находит того же пользователя, а не создаёт второго', async () => {
    const first = await initSession();
    await approve(first);
    const firstResult = await complete(first);

    const second = await initSession();
    await approve(second, IIN, 'Серікбаев М. Ә.'); // ФИО могло смениться в госбазе
    const secondResult = await complete(second);

    expect(firstResult.status).toBe('COMPLETED');
    expect(secondResult.status).toBe('COMPLETED');
    expect(await prisma.user.count()).toBe(1);

    // Оба входа живут одновременно: две сессии одного пользователя.
    const sessions = await prisma.authSession.count();
    expect(sessions).toBe(2);
  });

  it('отказ гражданина в приложении даёт EGOV_DENIED', async () => {
    const sessionId = await initSession();
    await api()
      .post('/api/auth/egov/dev-approve')
      .send({ sessionId, iin: IIN, fio: FIO, deny: true })
      .expect(200);

    const response = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(409);
    expect(response.body).toMatchObject({ code: 'EGOV_DENIED' });
  });

  it('неизвестная сессия — EGOV_SESSION_INVALID', async () => {
    const response = await api()
      .post('/api/auth/egov/complete')
      .send({ sessionId: crypto.randomUUID() })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'EGOV_SESSION_INVALID' });
  });

  it('одна сессия не обменивается на токены дважды', async () => {
    const sessionId = await initSession();
    await approve(sessionId);
    const first = await complete(sessionId);
    expect(first.status).toBe('COMPLETED');

    const again = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(409);
    expect(again.body).toMatchObject({ code: 'EGOV_SESSION_INVALID' });
  });

  it('подтвердить можно только ожидающую сессию', async () => {
    const sessionId = await initSession();
    await approve(sessionId);
    // Повторный approve той же сессии — уже нет: она не PENDING.
    const response = await api()
      .post('/api/auth/egov/dev-approve')
      .send({ sessionId, iin: IIN, fio: FIO })
      .expect(200);
    expect(response.body).toEqual({ ok: false });
  });

  it('заблокированный пользователь не входит и через eGov', async () => {
    const first = await initSession();
    await approve(first);
    await complete(first);
    await prisma.user.updateMany({ data: { status: 'BLOCKED' } });

    const second = await initSession();
    await approve(second);
    const response = await api()
      .post('/api/auth/egov/complete')
      .send({ sessionId: second })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'USER_BLOCKED' });
  });

  it('dev-approve отклоняет кривой ИИН', async () => {
    const sessionId = await initSession();
    await api()
      .post('/api/auth/egov/dev-approve')
      .send({ sessionId, iin: '123', fio: FIO })
      .expect(400);
  });

  it('токены из eGov-входа обновляются через обычный refresh', async () => {
    const sessionId = await initSession();
    await approve(sessionId);
    const result = await complete(sessionId);
    if (result.status !== 'COMPLETED') throw new Error('ожидали COMPLETED');

    const refreshed = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: result.tokens.refreshToken })
      .expect(200);
    const tokens = refreshed.body as TokenPair;
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });
});
