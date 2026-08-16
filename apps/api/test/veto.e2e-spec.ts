import type { EgovLoginResult, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { LOCKOUT_MONTHS } from '../src/lots/veto.service';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Право ВЕТО и Цифровой Карантин (T-045, FR-17).
 *
 * DoD: после ВЕТО повторное выставление объекта блокируется до окончания
 * карантина. Смысл — не наказать продавца, а не дать превратить торги в
 * бесплатную оценку: собрал цену, отказался, выставил заново.
 */

let app: INestApplication;
let prisma: PrismaService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

function randomCadastre(): string {
  return `20-317-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
}

/** Верифицированный продавец: другого пути к деньгам нет. */
async function seller(): Promise<{ token: string; id: string }> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin: randomIin(), fio: 'Продавец Тестович', biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');

  const me = await api()
    .get('/api/auth/me')
    .set(...auth(result.tokens.accessToken))
    .expect(200);
  const id = (me.body as { id: string }).id;

  const admin = await api()
    .post('/api/auth/dev-login')
    .send({ roles: ['ADMIN'] })
    .expect(200);
  await api()
    .patch(`/api/admin/users/${id}/roles`)
    .set(...auth((admin.body as TokenPair).accessToken))
    .send({ roles: ['SELLER'], reason: 'выдача роли продавца в тесте' })
    .expect(200);

  return { token: result.tokens.accessToken, id };
}

/** Лот, доведённый до FINISHED — состояния, в котором продавец решает. */
async function finishedLot(token: string, cadastre: string): Promise<string> {
  const created = await api()
    .post('/api/lots')
    .set(...auth(token))
    .send({ type: 'REALTY', cadastreOrVin: cadastre, startPriceTenge: 10_000_000 })
    .expect(201);
  const lotId = (created.body as LotView).id;

  // Через базу: путь до FINISHED проверяют другие тесты, здесь важен исход.
  await prisma.lot.update({ where: { id: lotId }, data: { status: 'FINISHED' } });
  return lotId;
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

describe('T-045: ВЕТО и Цифровой Карантин', () => {
  it('DoD: после ВЕТО объект нельзя выставить заново до конца карантина', async () => {
    const owner = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);

    const vetoed = await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(200);

    const body = vetoed.body as { status: string; lockoutUntil: string; actDocumentId: string };
    expect(body.status).toBe('VETOED');
    expect(body.actDocumentId).toBeTruthy();

    // Пять календарных месяцев — та же дата через пять месяцев.
    const until = new Date(body.lockoutUntil);
    const expected = new Date();
    expected.setUTCMonth(expected.getUTCMonth() + LOCKOUT_MONTHS);
    expect(Math.abs(until.getTime() - expected.getTime())).toBeLessThan(60_000);

    // Тот же объект — отказ.
    const blocked = await api()
      .post('/api/lots')
      .set(...auth(owner.token))
      .send({ type: 'REALTY', cadastreOrVin: cadastre, startPriceTenge: 12_000_000 })
      .expect(409);
    expect(blocked.body).toMatchObject({ code: 'OBJECT_IN_QUARANTINE' });
  });

  it('DoD: по истечении карантина объект снова свободен', async () => {
    const owner = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);
    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(200);

    // Подмена часов: отматываем срок карантина в прошлое, а не ждём пять
    // месяцев. Снятие идёт по метке времени, поэтому воркера здесь нет —
    // флаг был бы вторым источником правды об одном факте.
    await prisma.lot.update({
      where: { id: lotId },
      data: { lockoutUntil: new Date(Date.now() - 1_000) },
    });

    await api()
      .post('/api/lots')
      .set(...auth(owner.token))
      .send({ type: 'REALTY', cadastreOrVin: cadastre, startPriceTenge: 12_000_000 })
      .expect(201);
  });

  it('карантин закрывает объект и для другого продавца', async () => {
    const owner = await seller();
    const stranger = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);
    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(200);

    // Карантин наложен на ОБЪЕКТ: иначе его выставлял бы родственник продавца.
    await api()
      .post('/api/lots')
      .set(...auth(stranger.token))
      .send({ type: 'REALTY', cadastreOrVin: cadastre, startPriceTenge: 12_000_000 })
      .expect(409);
  });

  it('Акт ВЕТО содержит объект, цену и срок карантина', async () => {
    const owner = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);
    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(200);

    const act = await prisma.lotDocument.findFirstOrThrow({
      where: { lotId, kind: 'VETO_ACT' },
    });
    expect(act.fileName).toContain(cadastre);
    expect(act.sizeBytes).toBeGreaterThan(0);
  });

  it('подтверждение сделки закрывает лот штатно', async () => {
    const owner = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);

    const confirmed = await api()
      .post(`/api/lots/${lotId}/confirm`)
      .set(...auth(owner.token))
      .expect(200);
    expect(confirmed.body).toMatchObject({ status: 'CLOSED' });

    // Карантина нет: продавец сделку не отклонял.
    const stored = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(stored.status).toBe('CLOSED');
    expect(stored.lockoutUntil).toBeNull();
  });

  it('чужой лот и незавершённые торги решению не подлежат', async () => {
    const owner = await seller();
    const stranger = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);

    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(stranger.token))
      .expect(403);

    // Лот до конца торгов: решать ещё нечего.
    await prisma.lot.update({ where: { id: lotId }, data: { status: 'PHASE_III' } });
    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(409);
  });

  it('повторное ВЕТО невозможно — из VETOED лот никуда не переходит', async () => {
    const owner = await seller();
    const cadastre = randomCadastre();
    const lotId = await finishedLot(owner.token, cadastre);

    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(200);
    await api()
      .post(`/api/lots/${lotId}/veto`)
      .set(...auth(owner.token))
      .expect(409);

    expect(await prisma.lotDocument.count({ where: { lotId, kind: 'VETO_ACT' } })).toBe(1);
  });
});
