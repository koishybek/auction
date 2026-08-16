import type { BidUpdatedEvent, StateSnapshotEvent, TimerTickEvent } from '@auction/shared';
import { describe, expect, it } from 'vitest';

import {
  applyBid,
  applySnapshot,
  applyTick,
  bidLabel,
  canBid,
  formatTimer,
  initialHall,
  resolveWsUrl,
  timerZone,
} from './auction-hall';

const LOT = '11111111-1111-1111-1111-111111111111';

function snapshot(over: Partial<StateSnapshotEvent> = {}): StateSnapshotEvent {
  return {
    event: 'state_snapshot',
    lot_id: LOT,
    session_id: 'session-1',
    status: 'RUNNING',
    current_price_kzt: 1_000_000,
    bid_step_kzt: 30_000,
    next_price_kzt: 1_030_000,
    time_remaining_ms: 50_000,
    server_ts: 1_700_000_000_000,
    seq: 0,
    recent_bids: [],
    ...over,
  };
}

function bid(seq: number, priceTenge: number): BidUpdatedEvent {
  return {
    event: 'bid_updated',
    lot_id: LOT,
    current_price_kzt: priceTenge,
    bid_step_kzt: Math.round(priceTenge * 0.03),
    last_bidder_blind_id: `Инвестор #${String(700 + seq)}`,
    time_remaining_ms: 50_000,
    timestamp: 1_700_000_000_000 + seq,
    seq,
    session_id: 'session-1',
  };
}

function tick(remainingMs: number, seq: number): TimerTickEvent {
  return {
    event: 'timer_tick',
    lot_id: LOT,
    time_remaining_ms: remainingMs,
    server_ts: 1_700_000_000_000,
    seq,
  };
}

describe('T-039: цветовые зоны таймера', () => {
  it('пороги ровно на 20 и 5 секундах', () => {
    expect(timerZone(50_000)).toBe('calm');
    expect(timerZone(20_001)).toBe('calm');
    // Границы принадлежат верхней зоне: на самой двадцатой секунде ещё спокойно.
    expect(timerZone(20_000)).toBe('calm');
    expect(timerZone(19_999)).toBe('warning');
    expect(timerZone(5_001)).toBe('warning');
    expect(timerZone(5_000)).toBe('warning');
    expect(timerZone(4_999)).toBe('critical');
    expect(timerZone(0)).toBe('critical');
  });

  it('таймер показывает секунды и миллисекунды', () => {
    expect(formatTimer(50_000)).toBe('50.000');
    expect(formatTimer(4_321)).toBe('04.321');
    expect(formatTimer(0)).toBe('00.000');
    // Отрицательного остатка не бывает — сервер прислал бы ноль.
    expect(formatTimer(-100)).toBe('00.000');
  });
});

describe('T-039: адрес сокета', () => {
  it('имя хоста берётся из адресной строки, а не из настройки', () => {
    // Кука сессии привязана к имени хоста: открыв сайт как localhost, а сокет
    // как 127.0.0.1, участник пришёл бы на gateway неопознанным.
    expect(resolveWsUrl(undefined, { protocol: 'http:', hostname: 'localhost' }, '3200')).toBe(
      'ws://localhost:3200',
    );
    expect(resolveWsUrl('', { protocol: 'http:', hostname: '127.0.0.1' }, '3200')).toBe(
      'ws://127.0.0.1:3200',
    );
  });

  it('под TLS сокет тоже защищён', () => {
    expect(resolveWsUrl(undefined, { protocol: 'https:', hostname: 'auction.kz' }, '3200')).toBe(
      'wss://auction.kz:3200',
    );
  });

  it('явный адрес побеждает: за ingress порт ни при чём', () => {
    expect(
      resolveWsUrl('wss://auction.kz/ws', { protocol: 'https:', hostname: 'auction.kz' }, '3200'),
    ).toBe('wss://auction.kz/ws');
  });
});

describe('T-039: состояние зала', () => {
  it('снимок задаёт цену, шаг и сумму на кнопке', () => {
    const state = applySnapshot(snapshot());
    expect(state.currentPriceTenge).toBe(1_000_000);
    expect(state.nextPriceTenge).toBe(1_030_000);
    expect(bidLabel(state)).toContain('+3 %');
  });

  it('DoD: чужая ставка меняет сумму на кнопке тем же событием', () => {
    const state = applyBid(applySnapshot(snapshot()), bid(1, 1_030_000));

    // Ровно одно событие — и кнопка уже показывает новую цену: пересчёта по
    // отдельному запросу нет, иначе между ставкой и кнопкой был бы разрыв.
    expect(state.currentPriceTenge).toBe(1_030_000);
    expect(state.nextPriceTenge).toBe(1_030_000 + Math.round(1_030_000 * 0.03));
    expect(state.seq).toBe(1);
    expect(state.feed[0]?.blindId).toBe('Инвестор #701');
  });

  it('запоздавшее событие не откатывает цену назад', () => {
    const after = applyBid(applySnapshot(snapshot()), bid(2, 1_060_900));
    const stale = applyBid(after, bid(1, 1_030_000));

    // Пакеты приходят не в том порядке, в котором отправлены. Откат цены на
    // кнопке означал бы ставку не на ту сумму.
    expect(stale).toBe(after);
    expect(stale.currentPriceTenge).toBe(1_060_900);
  });

  it('лента копит ставки свежими сверху', () => {
    let state = applySnapshot(snapshot());
    state = applyBid(state, bid(1, 1_030_000));
    state = applyBid(state, bid(2, 1_060_900));

    expect(state.feed.map((entry) => entry.seq)).toEqual([2, 1]);
  });

  it('снимок после обрыва затирает состояние целиком', () => {
    const before = applyBid(applySnapshot(snapshot()), bid(1, 1_030_000));
    expect(before.feed).toHaveLength(1);

    // Склеивать своё представление с чужим нельзя: снимок и есть правда (T-030).
    const resynced = applySnapshot(
      snapshot({ current_price_kzt: 2_000_000, next_price_kzt: 2_060_000, seq: 7 }),
    );
    expect(resynced.seq).toBe(7);
    expect(resynced.currentPriceTenge).toBe(2_000_000);
    expect(resynced.feed).toHaveLength(0);
  });

  it('тик двигает только остаток, а пропуск номера требует пересинка', () => {
    const state = applySnapshot(snapshot());

    const same = applyTick(state, tick(48_000, 0));
    expect(same.state.timeRemainingMs).toBe(48_000);
    expect(same.resyncNeeded).toBe(false);

    // Сервер видит ставку номер 3, а мы её не получили — это потеря события.
    const skipped = applyTick(state, tick(50_000, 3));
    expect(skipped.resyncNeeded).toBe(true);
  });

  it('ставить можно только вошедшему и только в идущих торгах', () => {
    const running = applySnapshot(snapshot());
    expect(canBid(running, { authenticated: true })).toBe(true);
    expect(canBid(running, { authenticated: false })).toBe(false);

    const frozen = applySnapshot(snapshot({ status: 'FROZEN' }));
    expect(canBid(frozen, { authenticated: true })).toBe(false);

    const finished = applySnapshot(snapshot({ status: 'FINISHED' }));
    expect(canBid(finished, { authenticated: true })).toBe(false);

    // До первого снимка сумма неизвестна — нажимать не на что.
    expect(canBid(initialHall(LOT), { authenticated: true })).toBe(false);
  });
});
