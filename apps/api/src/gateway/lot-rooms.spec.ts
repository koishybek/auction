import { describe, expect, it } from 'vitest';

import type { BidService } from '../auction/bid.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { RedisService } from '../redis/redis.service';

import { LotRoomsService, type RoomMember } from './lot-rooms.service';

/**
 * Комнаты лотов: гонка входа и обрыва (T-055).
 *
 * Вход в НОВУЮ комнату ждёт подписки на канал Redis. Соединение, закрывшееся за
 * это время, раньше оказывалось в комнате навсегда: уборка при обрыве его тогда
 * ещё не находила. Комната с одним мёртвым участником не опустеет никогда —
 * значит канал не отпишется, а тик таймера будет рассылаться лоту, которого
 * никто не смотрит.
 *
 * Redis здесь подменён: проверяется порядок операций, а не сам Redis. Подписка
 * держится «висящей» ровно затем, чтобы попасть в то самое окно.
 */

interface Harness {
  readonly rooms: LotRoomsService;
  readonly subscribed: string[];
  readonly unsubscribed: string[];
  /** Отпустить подписку, которая держится. */
  release(): void;
}

function harness(): Harness {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let releaseSubscribe: (() => void) | null = null;

  const subscriber = {
    on: (): unknown => subscriber,
    subscribe: (channel: string): Promise<void> => {
      subscribed.push(channel);
      return new Promise<void>((resolve) => {
        releaseSubscribe = resolve;
      });
    },
    unsubscribe: (channel: string): Promise<void> => {
      unsubscribed.push(channel);
      return Promise.resolve();
    },
    quit: (): Promise<void> => Promise.resolve(),
  };

  const redis = { createDedicatedClient: () => subscriber } as unknown as RedisService;
  const bids = {
    channel: (lotId: string) => `auction:lot:${lotId}:events`,
  } as unknown as BidService;
  const metrics = { observeBroadcast: () => undefined } as unknown as MetricsService;

  return {
    rooms: new LotRoomsService(redis, bids, metrics),
    subscribed,
    unsubscribed,
    release: () => {
      releaseSubscribe?.();
    },
  };
}

function member(id: string, alive: { value: boolean }): RoomMember {
  return {
    id,
    send: () => undefined,
    isAlive: () => alive.value,
  };
}

const LOT = '11111111-1111-1111-1111-111111111111';

describe('комнаты лотов: вход и обрыв', () => {
  it('живой участник попадает в комнату', async () => {
    const h = harness();
    const alive = { value: true };
    const joining = h.rooms.join(LOT, member('c1', alive));
    h.release();
    await joining;

    expect(h.rooms.size(LOT)).toBe(1);
    expect(h.subscribed).toEqual(['auction:lot:11111111-1111-1111-1111-111111111111:events']);
  });

  it('участник, оборвавшийся во время подписки, в комнате не остаётся', async () => {
    const h = harness();
    const alive = { value: true };
    const joining = h.rooms.join(LOT, member('c1', alive));

    // Ровно то окно: подписка ещё не завершилась, а сокет уже закрыт.
    alive.value = false;
    h.release();
    await joining;

    expect(h.rooms.size(LOT)).toBe(0);
    // Комната убрана целиком, канал отпущен: иначе лот остался бы в рассылке
    // тиков навсегда.
    expect(h.rooms.roomCount()).toBe(0);
    expect(h.rooms.activeLots()).toEqual([]);
    expect(h.unsubscribed).toEqual(['auction:lot:11111111-1111-1111-1111-111111111111:events']);
  });

  it('второй участник входит без новой подписки и держит комнату', async () => {
    const h = harness();
    const alive = { value: true };
    const first = h.rooms.join(LOT, member('c1', alive));
    h.release();
    await first;

    // Комната уже есть: второму входящему подписка не нужна, и ждать нечего.
    await h.rooms.join(LOT, member('c2', { value: true }));
    expect(h.rooms.size(LOT)).toBe(2);
    expect(h.subscribed).toHaveLength(1);
  });
});
