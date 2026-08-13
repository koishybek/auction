import type { TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { OpenHouseSlotView } from '../src/lots/open-house.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

let app: INestApplication;
let prisma: PrismaService;

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

async function createLot(seller: TokenPair): Promise<string> {
  const response = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'REALTY', cadastreOrVin: '20-317-077-9999', startPriceTenge: 10_000_000 })
    .expect(201);
  return (response.body as { id: string }).id;
}

/** Время внутри 5-дневного окна. */
function slotTime(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
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

describe('T-018: Open House — слоты', () => {
  it('владелец назначает слоты; повтор расписания не создаёт дублей', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    const slots = [slotTime(24), slotTime(48)];

    const first = await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(seller))
      .send({ slotsAt: slots })
      .expect(201);
    expect(first.body as OpenHouseSlotView[]).toHaveLength(2);

    // Повторная отправка того же расписания — идемпотентна.
    const second = await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(seller))
      .send({ slotsAt: slots })
      .expect(201);
    expect(second.body as OpenHouseSlotView[]).toHaveLength(2);
  });

  it('чужому лоту слоты не назначить', async () => {
    const seller = await devLogin(['SELLER']);
    const other = await devLogin(['SELLER']);
    const lotId = await createLot(seller);

    await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(other))
      .send({ slotsAt: [slotTime(24)] })
      .expect(403);
  });

  it('слот в прошлом и за пределами 5 дней отклоняются', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);

    const past = await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(seller))
      .send({ slotsAt: [slotTime(-1)] })
      .expect(400);
    expect(past.body).toMatchObject({ code: 'SLOT_IN_PAST' });

    const tooFar = await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(seller))
      .send({ slotsAt: [slotTime(24 * 6)] })
      .expect(400);
    expect(tooFar.body).toMatchObject({ code: 'SLOT_OUT_OF_WINDOW' });
  });

  it('график виден анониму', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(seller))
      .send({ slotsAt: [slotTime(24)] })
      .expect(201);

    const anon = await api().get(`/api/lots/${lotId}/open-house`).expect(200);
    expect(anon.body as OpenHouseSlotView[]).toHaveLength(1);
  });
});

describe('T-018: Open House — запись', () => {
  async function makeSlot(): Promise<{ seller: TokenPair; slotId: string }> {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    const created = await api()
      .post(`/api/lots/${lotId}/open-house/slots`)
      .set(...auth(seller))
      .send({ slotsAt: [slotTime(24)] })
      .expect(201);
    const slotId = (created.body as OpenHouseSlotView[])[0]?.id ?? '';
    return { seller, slotId };
  }

  it('инвестор записывается; DoD: двойная запись невозможна', async () => {
    const { seller, slotId } = await makeSlot();
    const investor = await devLogin(['INVESTOR']);
    const lotId = (await prisma.openHouseSlot.findUniqueOrThrow({ where: { id: slotId } })).lotId;

    const booked = await api()
      .post(`/api/lots/${lotId}/open-house/slots/${slotId}/book`)
      .set(...auth(investor))
      .expect(200);
    expect((booked.body as OpenHouseSlotView).bookedByMe).toBe(true);
    expect((booked.body as OpenHouseSlotView).bookedCount).toBe(1);

    const twice = await api()
      .post(`/api/lots/${lotId}/open-house/slots/${slotId}/book`)
      .set(...auth(investor))
      .expect(409);
    expect(twice.body).toMatchObject({ code: 'ALREADY_BOOKED' });

    // В БД ровно одна запись — уникальный ключ, а не проверка кодом.
    expect(await prisma.openHouseBooking.count({ where: { slotId } })).toBe(1);
    void seller;
  });

  it('конкурентная двойная запись: из 5 одновременных попыток проходит ровно одна', async () => {
    const { slotId } = await makeSlot();
    const investor = await devLogin(['INVESTOR']);
    const lotId = (await prisma.openHouseSlot.findUniqueOrThrow({ where: { id: slotId } })).lotId;

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        api()
          .post(`/api/lots/${lotId}/open-house/slots/${slotId}/book`)
          .set(...auth(investor))
          .then((response) => response.status),
      ),
    );

    expect(attempts.filter((status) => status === 200)).toHaveLength(1);
    expect(attempts.filter((status) => status === 409)).toHaveLength(4);
    expect(await prisma.openHouseBooking.count({ where: { slotId } })).toBe(1);
  });

  it('продавец не записывается на собственный показ', async () => {
    const { seller, slotId } = await makeSlot();
    const lotId = (await prisma.openHouseSlot.findUniqueOrThrow({ where: { id: slotId } })).lotId;

    // У продавца нет роли INVESTOR — 403 гвардом.
    await api()
      .post(`/api/lots/${lotId}/open-house/slots/${slotId}/book`)
      .set(...auth(seller))
      .expect(403);
  });

  it('отмена своей записи освобождает место; чужая запись недоступна', async () => {
    const { slotId } = await makeSlot();
    const investorA = await devLogin(['INVESTOR']);
    const investorB = await devLogin(['INVESTOR']);
    const lotId = (await prisma.openHouseSlot.findUniqueOrThrow({ where: { id: slotId } })).lotId;
    const base = `/api/lots/${lotId}/open-house/slots/${slotId}/book`;

    await api()
      .post(base)
      .set(...auth(investorA))
      .expect(200);
    // B отменяет, ничего не имея, — 404, запись A нетронута.
    await api()
      .delete(base)
      .set(...auth(investorB))
      .expect(404);
    expect(await prisma.openHouseBooking.count({ where: { slotId } })).toBe(1);

    await api()
      .delete(base)
      .set(...auth(investorA))
      .expect(204);
    expect(await prisma.openHouseBooking.count({ where: { slotId } })).toBe(0);
  });

  it('запись в несуществующий слот — 404', async () => {
    const investor = await devLogin(['INVESTOR']);
    await api()
      .post(`/api/lots/${crypto.randomUUID()}/open-house/slots/${crypto.randomUUID()}/book`)
      .set(...auth(investor))
      .expect(404);
  });
});
