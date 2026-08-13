import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Finisher (T-027).
 *
 * Главное здесь — DoD: ставка в последнюю миллисекунду против закрытия торгов.
 * Победить обязано ровно одно. Двойной исход означал бы либо принятую ставку в
 * закрытых торгах, либо двух победителей одного лота, — и то и другое про
 * деньги участников.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let finisher: FinisherService;

/** Торги без лота в БД: скрипту завершения нужны только цена, дедлайн и seq. */
async function openSession(priceTenge = 1_000_000): Promise<{ lotId: string; sessionId: string }> {
  const lotId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await state.start({ lotId, sessionId, priceTiyn: BigInt(priceTenge) * 100n });
  return { lotId, sessionId };
}

/** Сдвинуть дедлайн на заданный момент, сохранив остальное состояние. */
async function setDeadline(lotId: string, deadlineMs: number): Promise<void> {
  await redis.client.hset(state.stateKey(lotId), 'deadlineMs', String(deadlineMs));
  await redis.client.zadd(state.deadlinesKey(), deadlineMs, lotId);
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
  finisher = app.get(FinisherService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-027: завершение торгов', () => {
  it('DoD: ставка в последнюю мс против финиша — исход ровно один', async () => {
    // Двести прогонов: гонка редкая по своей природе, и на десятке попыток
    // сломанная реализация выглядела бы исправной.
    const outcomes = { bid: 0, finish: 0 };

    for (let round = 0; round < 200; round += 1) {
      const { lotId } = await openSession();
      const next = await bids.nextPriceTiyn(lotId);

      // Дедлайн гуляет вокруг «сейчас» от −5 до +14 мс. Ровно на «сейчас» его
      // ставить бесполезно: пока запрос доедет до Redis, он уже в прошлом, и
      // финиш выигрывает всегда. Смещение перебирается по кругу, а не
      // случайно, — прогон должен воспроизводиться.
      await setDeadline(lotId, Date.now() + (-5 + (round % 20)));

      const [bid, finish] = await Promise.all([
        bids.place({
          lotId,
          bidderId: 'investor-1',
          blindCode: 'Инвестор #704',
          expectedAmountTiyn: next,
        }),
        finisher.finishLot(lotId),
      ]);

      const bidWon = bid.status === 'ACCEPTED';
      const finishWon = finish.kind === 'FINISHED';

      // Ровно один. Оба — двойной исход, ни одного — потерянный лот.
      expect(
        bidWon !== finishWon,
        `раунд ${String(round)}: ставка=${bid.status}, финиш=${finish.kind}`,
      ).toBe(true);

      const live = await state.read(lotId);
      if (bidWon) {
        outcomes.bid += 1;
        // Ставка успела: торги живы, таймер сброшен, номер вырос.
        expect(live?.status).toBe('RUNNING');
        expect(live?.seq).toBe(1);
        expect((live?.deadlineMs ?? 0) - (live?.nowMs ?? 0)).toBeGreaterThan(45_000);
      } else {
        outcomes.finish += 1;
        // Финиш успел: торги закрыты, ставка отбита как опоздавшая.
        expect(live?.status).toBe('FINISHED');
        expect(live?.seq).toBe(0);
        expect(bid.status === 'REJECTED' && bid.code).toMatch(/TIMER_EXPIRED|NOT_RUNNING/);
      }

      await state.drop(lotId);
    }

    // Обе ветки обязаны встретиться, иначе тест проверял бы одну и ту же.
    expect(outcomes.bid, 'ставка не выиграла ни разу').toBeGreaterThan(0);
    expect(outcomes.finish, 'финиш не выиграл ни разу').toBeGreaterThan(0);
  });

  it('живые торги не закрываются', async () => {
    const { lotId } = await openSession();

    const outcome = await finisher.finishLot(lotId);
    expect(outcome.kind).toBe('STILL_RUNNING');
    expect((await state.read(lotId))?.status).toBe('RUNNING');
  });

  it('закрытие идемпотентно: второй проход ничего не меняет', async () => {
    const { lotId } = await openSession();
    await setDeadline(lotId, Date.now() - 1);

    const first = await finisher.finishLot(lotId);
    expect(first.kind).toBe('FINISHED');

    // Реплик воркера несколько, и все они видят один и тот же лот.
    const second = await finisher.finishLot(lotId);
    expect(second.kind).toBe('ALREADY_CLOSED');
  });

  it('закрытые торги ставок не принимают', async () => {
    const { lotId } = await openSession();
    const next = await bids.nextPriceTiyn(lotId);
    await setDeadline(lotId, Date.now() - 1);
    await finisher.finishLot(lotId);

    const late = await bids.place({
      lotId,
      bidderId: 'investor-1',
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: next,
    });
    expect(late.status).toBe('REJECTED');
    expect(late.status === 'REJECTED' && late.code).toBe('NOT_RUNNING');
  });

  it('победителем становится последний, чью ставку приняли', async () => {
    const { lotId } = await openSession();

    await bids.place({
      lotId,
      bidderId: 'first',
      blindCode: 'Инвестор #100',
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });
    await bids.place({
      lotId,
      bidderId: 'second',
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });

    await setDeadline(lotId, Date.now() - 1);
    const outcome = await finisher.finishLot(lotId);

    expect(outcome.kind).toBe('FINISHED');
    if (outcome.kind !== 'FINISHED') return;
    expect(outcome.seq).toBe(2);
    expect(outcome.winnerBlindId).toBe('Инвестор #704');
    expect(outcome.winnerUserId).toBe('second');
    // 1 000 000 → 1 030 000 → 1 060 900
    expect(outcome.finalPriceTiyn).toBe(106_090_000n);
  });

  it('торги без единой ставки закрываются без победителя', async () => {
    const { lotId } = await openSession();
    await setDeadline(lotId, Date.now() - 1);

    const outcome = await finisher.finishLot(lotId);
    expect(outcome.kind).toBe('FINISHED');
    if (outcome.kind !== 'FINISHED') return;
    // Торги состоялись, покупателя нет — это валидный исход, а не ошибка.
    expect(outcome.winnerBlindId).toBeNull();
    expect(outcome.seq).toBe(0);
  });

  it('закрытие рассылается в канал лота', async () => {
    const { lotId, sessionId } = await openSession();
    await bids.place({
      lotId,
      bidderId: 'investor-1',
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: await bids.nextPriceTiyn(lotId),
    });

    const subscriber = redis.createDedicatedClient('test:finish-subscriber');
    const received: string[] = [];
    await subscriber.subscribe(bids.channel(lotId));
    subscriber.on('message', (_channel: string, payload: string) => {
      received.push(payload);
    });

    await setDeadline(lotId, Date.now() - 1);
    await finisher.finishLot(lotId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await subscriber.unsubscribe(bids.channel(lotId));

    const event = JSON.parse(received[0] ?? '{}') as Record<string, unknown>;
    expect(event['event']).toBe('auction_finished');
    expect(event['lot_id']).toBe(lotId);
    expect(event['session_id']).toBe(sessionId);
    expect(event['final_price_kzt']).toBe(1_030_000);
    // В объявлении победителя — псевдоним, реального id нет (FR-09).
    expect(event['winner_blind_id']).toBe('Инвестор #704');
    expect(JSON.stringify(event)).not.toContain('investor-1');
  });

  it('проход воркера закрывает все истёкшие лоты разом', async () => {
    const lots = await Promise.all([openSession(), openSession(), openSession()]);
    for (const { lotId } of lots) {
      await setDeadline(lotId, Date.now() - 1);
    }
    // Ещё один живой — его трогать нельзя.
    const alive = await openSession();

    const finished = await finisher.finishDue(Date.now());

    expect(finished).toHaveLength(3);
    expect((await state.read(alive.lotId))?.status).toBe('RUNNING');
    // Индекс дедлайнов подчищен: закрытые лоты больше не кандидаты.
    expect(await state.dueLots(Date.now())).toHaveLength(0);
  });
});
