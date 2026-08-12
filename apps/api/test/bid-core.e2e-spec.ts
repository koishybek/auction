import { SMART_HAMMER_TIMER_MS } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidService, type BidOutcome } from '../src/auction/bid.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';

/**
 * Ядро ставки (T-024).
 *
 * Тесты бьют прямо в Lua-скрипт, минуя HTTP: проверяется атомарность, а не
 * маршрутизация. Главный риск проекта — две принятые ставки на один шаг, и
 * ловится он здесь.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;

/** Торги без лота и продавца: ядру нужны только цена, дедлайн и seq. */
async function openSession(priceTenge: number): Promise<{ lotId: string; sessionId: string }> {
  const lotId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await state.start({ lotId, sessionId, priceTiyn: BigInt(priceTenge) * 100n });
  return { lotId, sessionId };
}

async function place(
  lotId: string,
  expectedTiyn: bigint,
  bidderId = 'bidder-1',
): Promise<BidOutcome> {
  return bids.place({
    lotId,
    bidderId,
    blindCode: 'Инвестор #704',
    expectedAmountTiyn: expectedTiyn,
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  state = app.get(AuctionStateService);
  bids = app.get(BidService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-024: атомарное ядро ставки', () => {
  it('DoD: 100 одновременных ставок на один шаг → ровно одна принята', async () => {
    const { lotId } = await openSession(45_000_000);
    const next = await bids.nextPriceTiyn(lotId);
    expect(next).toBe(4_635_000_000n); // 45 000 000 ₸ +3 % = 46 350 000 ₸ (ТЗ §2.1)

    // Все сто присылают одну и ту же сумму — ровно так выглядит гонка на
    // популярном лоте. Победить обязан один: две принятые ставки на один шаг
    // это юридический спор о деньгах, а не «неточность счётчика».
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, index) => place(lotId, next, `bidder-${String(index)}`)),
    );

    const accepted = outcomes.filter((outcome) => outcome.status === 'ACCEPTED');
    const mismatched = outcomes.filter(
      (outcome) => outcome.status === 'REJECTED' && outcome.code === 'PRICE_MISMATCH',
    );

    expect(accepted).toHaveLength(1);
    expect(mismatched).toHaveLength(99);

    // Цена сдвинулась ровно на один шаг, номер ставки — ровно один.
    const live = await state.read(lotId);
    expect(live?.priceTiyn).toBe(4_635_000_000n);
    expect(live?.seq).toBe(1);
  });

  it('шаг считается банковским округлением до целого тенге', async () => {
    // Половина округляется к чётному — правило зафиксировано планом (T-024)
    // и живёт единственной реализацией: в Lua-скрипте.
    const cases: readonly [number, number][] = [
      [45_000_000, 46_350_000], // ровно, пример из ТЗ §2.1
      [100, 103], // ровно
      [50, 52], // 51,5 → к чётному вверх
      [150, 154], // 154,5 → к чётному вниз
      [5, 5], // 5,15 → 5
      [1, 1], // 1,03 → 1
      [17, 18], // 17,51 → 18
    ];

    for (const [priceTenge, expectedTenge] of cases) {
      const { lotId } = await openSession(priceTenge);
      const next = await bids.nextPriceTiyn(lotId);
      expect(next, `${String(priceTenge)} ₸ +3 %`).toBe(BigInt(expectedTenge) * 100n);
    }
  });

  it('цена после каждой ставки остаётся кратной тенге', async () => {
    const { lotId } = await openSession(45_000_000);

    // Иначе toTenge на границе сериализации бросит, и лот перестанет
    // открываться посреди торгов.
    //
    // Участники чередуются: перебивать собственную последнюю ставку нельзя
    // (T-025), и подряд от одного лица торги идти не могут.
    for (let step = 0; step < 10; step += 1) {
      const next = await bids.nextPriceTiyn(lotId);
      const outcome = await place(lotId, next, `bidder-${String(step % 2)}`);
      expect(outcome.status).toBe('ACCEPTED');
      expect(next % 100n).toBe(0n);
    }

    const live = await state.read(lotId);
    expect(live?.seq).toBe(10);
    expect((live?.priceTiyn ?? 1n) % 100n).toBe(0n);
  });

  it('принятая ставка возвращает таймер к 50 секундам', async () => {
    const { lotId } = await openSession(1_000_000);
    const before = await state.read(lotId);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const outcome = await place(lotId, await bids.nextPriceTiyn(lotId));
    expect(outcome.status).toBe('ACCEPTED');

    const after = await state.read(lotId);
    expect(after?.deadlineMs).toBeGreaterThan(before?.deadlineMs ?? 0);
    // Остаток снова полный: «любая принятая ставка сбрасывает таймер».
    expect((after?.deadlineMs ?? 0) - (after?.nowMs ?? 0)).toBeGreaterThan(
      SMART_HAMMER_TIMER_MS - 500,
    );
  });

  it('сумма, не равная шагу, отклоняется', async () => {
    const { lotId } = await openSession(1_000_000);
    const next = await bids.nextPriceTiyn(lotId);

    // Сервер не доверяет присланной сумме, он её сверяет (QA-04).
    for (const wrong of [next - 100n, next + 100n, 0n, 1n]) {
      const outcome = await place(lotId, wrong);
      expect(outcome.status).toBe('REJECTED');
      expect(outcome.status === 'REJECTED' && outcome.code).toBe('PRICE_MISMATCH');
    }

    const live = await state.read(lotId);
    expect(live?.seq).toBe(0);
  });

  it('после истечения таймера ставка не принимается', async () => {
    const { lotId, sessionId } = await openSession(1_000_000);

    // Дедлайн в прошлом — то же, что 50 секунд тишины.
    await state.drop(lotId);
    await state.restore({
      lotId,
      sessionId,
      status: 'RUNNING',
      priceTiyn: 100_000_000n,
      seq: 0,
      deadlineMs: Date.now() - 1_000,
    });

    const outcome = await place(lotId, await bids.nextPriceTiyn(lotId));
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.status === 'REJECTED' && outcome.code).toBe('TIMER_EXPIRED');
  });

  it('по лоту без торгов ставка невозможна', async () => {
    const outcome = await place(crypto.randomUUID(), 100n);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.status === 'REJECTED' && outcome.code).toBe('NO_SESSION');
  });

  it('принятая ставка публикуется в канал лота', async () => {
    const { lotId, sessionId } = await openSession(1_000_000);

    // Тот же канал, через который gateway разошлёт событие клиентам (T-023).
    const subscriber = redis.createDedicatedClient('test:subscriber');
    const received: string[] = [];
    await subscriber.subscribe(bids.channel(lotId));
    subscriber.on('message', (_channel: string, payload: string) => {
      received.push(payload);
    });

    const next = await bids.nextPriceTiyn(lotId);
    const outcome = await place(lotId, next);
    expect(outcome.status).toBe('ACCEPTED');

    await new Promise((resolve) => setTimeout(resolve, 300));
    await subscriber.unsubscribe(bids.channel(lotId));

    expect(received).toHaveLength(1);
    const event = JSON.parse(received[0] ?? '{}') as Record<string, unknown>;

    // Структура ровно по ТЗ §2.1: ключ event, суммы в тенге, шаг — величина
    // прибавки, а не новая цена.
    expect(event['event']).toBe('bid_updated');
    expect(event['lot_id']).toBe(lotId);
    expect(event['current_price_kzt']).toBe(1_030_000); // 1 000 000 ₸ +3 %
    expect(event['bid_step_kzt']).toBe(30_000);
    expect(event['time_remaining_ms']).toBe(SMART_HAMMER_TIMER_MS);
    expect(typeof event['timestamp']).toBe('number');

    // Сверх схемы ТЗ — для ресинка после обрыва (T-030).
    expect(event['seq']).toBe(1);
    expect(event['session_id']).toBe(sessionId);

    // В ленте только псевдоним: реальные ФИО, ИИН и id не появляются никогда (FR-09).
    expect(event['last_bidder_blind_id']).toBe('Инвестор #704');
    expect(JSON.stringify(event)).not.toContain('bidder-1');

    // Сумма в тенге совпадает с тем, что вернуло ядро в тиынах.
    expect(BigInt(event['current_price_kzt'] as number) * 100n).toBe(next);
  });

  it('последовательные ставки наращивают цену и seq без пропусков', async () => {
    const { lotId } = await openSession(1_000);
    const seen: number[] = [];

    // Двое перебивают друг друга по очереди: себя перебивать нельзя (T-025).
    for (let step = 0; step < 5; step += 1) {
      const outcome = await place(
        lotId,
        await bids.nextPriceTiyn(lotId),
        `bidder-${String(step % 2)}`,
      );
      if (outcome.status !== 'ACCEPTED') {
        throw new Error(`Ставка ${String(step)} отклонена: ${outcome.code}`);
      }
      seen.push(outcome.seq);
    }

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    // 1000 → 1030 → 1061 → 1093 → 1126 → 1160 (банковское округление на каждом шаге)
    const live = await state.read(lotId);
    expect(live?.priceTiyn).toBe(116_000n);
  });
});
