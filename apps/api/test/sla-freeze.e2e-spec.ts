import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { SlaFreezeService } from '../src/auction/sla-freeze.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * SLA Freeze (T-032, FR-08).
 *
 * Ключевое утверждение приёмки: после возобновления остаток совпадает со
 * снимком. Пауза обязана замораживать время, а не тратить его — иначе сбой
 * связи молча съедает секунды, за которые люди платят деньги.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let freeze: SlaFreezeService;
let finisher: FinisherService;

/** Торги без лота в БД: механике заморозки нужны только статус и дедлайн. */
async function openSession(): Promise<{ lotId: string; sessionId: string }> {
  const lotId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await state.start({ lotId, sessionId, priceTiyn: 100_000_000n });
  return { lotId, sessionId };
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
  freeze = app.get(SlaFreezeService);
  finisher = app.get(FinisherService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-032: SLA Freeze', () => {
  it('DoD: после возобновления остаток совпадает со снимком', async () => {
    const { lotId } = await openSession();

    // Даём таймеру немного стечь, чтобы снимок был осмысленным.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const frozen = await freeze.freeze(lotId, 'проверка');
    expect(frozen).not.toBeNull();
    if (frozen === null) return;
    expect(frozen.remainingMs).toBeLessThan(50_000);
    expect(frozen.remainingMs).toBeGreaterThan(47_000);

    // Пауза длится реальное время: за неё остаток не должен уменьшиться ни на мс.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const during = await state.read(lotId);
    expect(during?.status).toBe('FROZEN');

    const resumed = await freeze.resume(lotId);
    expect(resumed).not.toBeNull();
    if (resumed === null) return;

    // Главное утверждение: вернули ровно то, что забрали.
    expect(resumed.remainingMs).toBe(frozen.remainingMs);

    const after = await state.read(lotId);
    expect(after?.status).toBe('RUNNING');
    const liveRemaining = (after?.deadlineMs ?? 0) - (after?.nowMs ?? 0);
    expect(Math.abs(liveRemaining - frozen.remainingMs)).toBeLessThan(500);
  });

  it('замороженный лот не закрывается finisher-ом', async () => {
    const { lotId } = await openSession();
    await freeze.freeze(lotId, 'проверка');

    // Дедлайн в прошлом: без защиты finisher закрыл бы торги ровно тогда,
    // когда у участников нет связи, чтобы возразить.
    await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(Date.now() - 10_000));

    expect(await state.dueLots(Date.now())).not.toContain(lotId);
    const outcome = await finisher.finishLot(lotId);
    expect(outcome.kind).toBe('ALREADY_CLOSED');
    expect((await state.read(lotId))?.status).toBe('FROZEN');
  });

  it('замороженные торги ставок не принимают', async () => {
    const { lotId } = await openSession();
    const next = await bids.nextPriceTiyn(lotId);
    await freeze.freeze(lotId, 'проверка');

    const outcome = await bids.place({
      lotId,
      bidderId: 'investor-1',
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: next,
    });
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.status === 'REJECTED' && outcome.code).toBe('NOT_RUNNING');
  });

  it('повторная заморозка идущих торгов не сбрасывает снимок', async () => {
    const { lotId } = await openSession();
    const first = await freeze.freeze(lotId, 'первая');
    // Несколько инстансов gateway могут увидеть деградацию одновременно.
    const second = await freeze.freeze(lotId, 'вторая');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('заморозка и возобновление уходят в канал лота', async () => {
    const { lotId, sessionId } = await openSession();
    const subscriber = redis.createDedicatedClient('test:sla-subscriber');
    const received: Record<string, unknown>[] = [];
    await subscriber.subscribe(bids.channel(lotId));
    subscriber.on('message', (_channel: string, payload: string) => {
      received.push(JSON.parse(payload) as Record<string, unknown>);
    });

    const frozen = await freeze.freeze(lotId, 'проверка');
    await freeze.resume(lotId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await subscriber.unsubscribe(bids.channel(lotId));

    const [freezeEvent, resumeEvent] = received;
    expect(freezeEvent?.['event']).toBe('sla_freeze');
    expect(freezeEvent?.['lot_id']).toBe(lotId);
    expect(freezeEvent?.['session_id']).toBe(sessionId);
    // Клиенту сообщают и остаток, и через сколько ждать возобновления (ТЗ §2.2).
    expect(freezeEvent?.['time_remaining_ms']).toBe(frozen?.remainingMs);
    expect(freezeEvent?.['resume_in_ms']).toBe(60_000);

    expect(resumeEvent?.['event']).toBe('sla_resume');
    expect(resumeEvent?.['time_remaining_ms']).toBe(frozen?.remainingMs);
  });

  it('воркер возобновляет торги, когда пауза истекла', async () => {
    const { lotId } = await openSession();
    const frozen = await freeze.freeze(lotId, 'проверка');

    // Ждать реальную минуту в тесте незачем: двигаем момент возобновления.
    await redis.client.zadd(state.frozenKey(), Date.now() - 1, lotId);

    const resumed = await freeze.resumeDue(Date.now());
    expect(resumed).toContain(lotId);
    expect((await state.read(lotId))?.status).toBe('RUNNING');

    // Лот вернулся в индекс дедлайнов — finisher снова его видит.
    const live = await state.read(lotId);
    expect(await state.dueLots((live?.deadlineMs ?? 0) + 1)).toContain(lotId);
    expect(resumed).toHaveLength(1);
    expect(frozen).not.toBeNull();
  });

  it('состояние сессии в PostgreSQL следует за заморозкой', async () => {
    // Здесь нужен настоящий лот: снимок пишется в строку сессии.
    const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
    const lot = await prisma.lot.create({
      data: {
        sellerId: seller.id,
        type: 'REALTY',
        cadastreOrVin: `LOT-${crypto.randomUUID()}`,
        startPriceTiyn: 100_000_000n,
        status: 'PHASE_III',
      },
      select: { id: true },
    });
    const session = await prisma.auctionSession.create({
      data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
      select: { id: true },
    });
    await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: 100_000_000n });

    const frozen = await freeze.freeze(lot.id, 'проверка');
    const paused = await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(paused.status).toBe('FROZEN');
    expect(paused.freezeSnapshotMs).toBe(frozen?.remainingMs);

    await freeze.resume(lot.id);
    const running = await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(running.status).toBe('RUNNING');
    // Снимок снят: он имеет смысл только пока пауза длится.
    expect(running.freezeSnapshotMs).toBeNull();
  });
});
