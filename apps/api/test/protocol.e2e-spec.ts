import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidOutboxService } from '../src/auction/bid-outbox.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { ProtocolService } from '../src/documents/protocol.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/integrations/storage/storage.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Протокол торгов (T-044, FR-06, ОВ-6).
 *
 * DoD: протокол появляется сам после закрытия торгов, а его содержимое
 * сходится со ставками из PostgreSQL. Главная проверка здесь — что документ
 * НЕ собирается, пока ставки не доехали: официальный протокол с потерянной
 * последней ставкой хуже, чем протокол на секунду позже.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let outbox: BidOutboxService;
let finisher: FinisherService;
let protocols: ProtocolService;
let storage: StorageProvider;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

interface Arena {
  readonly lotId: string;
  readonly sessionId: string;
  readonly buyers: readonly string[];
}

async function arena(): Promise<Arena> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: 1_000_000_00n,
      status: 'PHASE_III',
    },
    select: { id: true, startPriceTiyn: true },
  });
  const session = await prisma.auctionSession.create({
    data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: lot.startPriceTiyn });

  const buyers: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const buyer = await prisma.user.create({
      data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
      select: { id: true },
    });
    buyers.push(buyer.id);
  }
  return { lotId: lot.id, sessionId: session.id, buyers };
}

async function placeBid(lotId: string, bidderId: string, seq: number): Promise<void> {
  const outcome = await bids.place({
    lotId,
    bidderId,
    blindCode: `Инвестор #${String(700 + seq)}`,
    expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
  });
  expect(outcome.status).toBe('ACCEPTED');
}

async function finish(lotId: string): Promise<void> {
  await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 1));
  expect((await finisher.finishLot(lotId)).kind).toBe('FINISHED');
}

async function protocolHtml(lotId: string): Promise<string> {
  const document = await prisma.lotDocument.findFirstOrThrow({
    where: { lotId, kind: 'PROTOCOL' },
  });
  const handle = await storage.get(document.fileKey);
  expect(handle).not.toBeNull();

  const chunks: Buffer[] = [];
  for await (const chunk of handle?.stream ?? []) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  state = app.get(AuctionStateService);
  bids = app.get(BidService);
  outbox = app.get(BidOutboxService);
  finisher = app.get(FinisherService);
  protocols = app.get(ProtocolService);
  storage = app.get<StorageProvider>(STORAGE_PROVIDER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-044: протокол торгов', () => {
  it('DoD: содержимое протокола сходится со ставками из базы', async () => {
    const { lotId, sessionId, buyers } = await arena();
    await placeBid(lotId, buyers[0] ?? '', 1);
    await placeBid(lotId, buyers[1] ?? '', 2);
    await placeBid(lotId, buyers[0] ?? '', 3);
    await outbox.drain();
    await finish(lotId);

    expect(await protocols.generateIfComplete(sessionId)).not.toBeNull();
    const html = await protocolHtml(lotId);

    const stored = await prisma.bid.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
    expect(stored).toHaveLength(3);
    for (const bid of stored) {
      // Каждая ставка из базы обязана быть в документе: суммой, псевдонимом и
      // серверным временем. Протокол — доказательство, а не пересказ.
      expect(html).toContain(bid.blindCode);
      expect(html).toContain(bid.serverTs.toISOString());
      expect(html).toContain(Number(bid.amountTiyn / 100n).toLocaleString('ru-KZ'));
    }

    // Победитель — последняя принятая ставка, и он назван псевдонимом.
    expect(html).toContain('Инвестор #703');
    expect(html).toContain('Принято ставок');
    expect(html).toContain('>3<');

    // Реальных участников в документе нет (FR-09).
    for (const buyer of buyers) {
      expect(html).not.toContain(buyer);
    }
  });

  it('протокол не собирается, пока ставки не доехали в базу', async () => {
    const { lotId, sessionId, buyers } = await arena();
    await placeBid(lotId, buyers[0] ?? '', 1);
    // Намеренно НЕ разбираем outbox: ставка есть в Redis, но не в PostgreSQL.
    await finish(lotId);

    // Документ с потерянной ставкой хуже, чем документ на секунду позже.
    expect(await protocols.generateIfComplete(sessionId)).toBeNull();
    expect(await prisma.lotDocument.count({ where: { lotId, kind: 'PROTOCOL' } })).toBe(0);

    // Ставки доехали — протокол собирается следующим заходом.
    await outbox.drain();
    expect(await protocols.generateIfComplete(sessionId)).not.toBeNull();
    expect(await prisma.lotDocument.count({ where: { lotId, kind: 'PROTOCOL' } })).toBe(1);
  });

  it('протокол один на сессию и не переписывается', async () => {
    const { lotId, sessionId, buyers } = await arena();
    await placeBid(lotId, buyers[0] ?? '', 1);
    await outbox.drain();
    await finish(lotId);

    const first = await protocols.generateIfComplete(sessionId);
    const second = await protocols.generateIfComplete(sessionId);

    expect(second).toBe(first);
    expect(await prisma.lotDocument.count({ where: { lotId, kind: 'PROTOCOL' } })).toBe(1);

    // Победившая ставка связана с сессией — по протоколу видно, какая именно
    // закрыла торги (это поле оставалось пустым с T-027).
    const session = await prisma.auctionSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.winnerBidId).not.toBeNull();
    expect(session.protocolDocId).toBe(first);
  });

  it('торги без ставок дают протокол без победителя', async () => {
    const { lotId, sessionId } = await arena();
    await finish(lotId);

    expect(await protocols.generateIfComplete(sessionId)).not.toBeNull();
    const html = await protocolHtml(lotId);

    // Торги состоялись, покупателя не нашлось — это тоже факт для протокола.
    expect(html).toContain('ставок не поступило');
    expect(html).toContain('Ставок не поступило');
  });

  it('незакрытые торги протокола не имеют', async () => {
    const { lotId, sessionId } = await arena();

    expect(await protocols.generateIfComplete(sessionId)).toBeNull();
    await api().get(`/api/lots/${lotId}/protocol`).expect(401);
  });

  it('ручка отдаёт документ после закрытия', async () => {
    const { lotId, sessionId, buyers } = await arena();
    await placeBid(lotId, buyers[0] ?? '', 1);
    await outbox.drain();
    await finish(lotId);
    await protocols.generateIfComplete(sessionId);

    const tokens = await api()
      .post('/api/auth/dev-login')
      .send({ roles: ['INVESTOR'] })
      .expect(200);
    const response = await api()
      .get(`/api/lots/${lotId}/protocol`)
      .set('Authorization', `Bearer ${(tokens.body as { accessToken: string }).accessToken}`)
      .expect(200);

    expect((response.body as { documentId: string }).documentId).toBeTruthy();
  });
});
