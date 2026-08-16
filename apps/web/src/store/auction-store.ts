'use client';

import type {
  BidUpdatedEvent,
  StateSnapshotEvent,
  TimerTickEvent,
  PlaceBidMessage,
} from '@auction/shared';
import { create } from 'zustand';

import {
  applyBid,
  applySnapshot,
  applyTick,
  initialHall,
  type HallState,
} from '@/lib/auction-hall';

/**
 * Состояние аукционного зала (T-039).
 *
 * Единственный владелец правды о торгах — сервер. Стор ничего не вычисляет
 * сам: ни цену, ни остаток таймера, ни момент завершения. Он складывает то,
 * что пришло по сокету, и отдаёт компонентам.
 */

/** Задержки переподключения. Растут, чтобы не добивать сервер, который лежит. */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * Сколько терпим тишину в сокете, прежде чем считать связь оборванной.
 *
 * Сервер шлёт ping раз в 2 с и тик таймера раз в 1 с (ТЗ §2.1–2.2), поэтому
 * восемь секунд молчания означают, что соединения больше нет. Ждать, пока это
 * заметит операционная система, нельзя: оборванный сокет остаётся «открытым»
 * для браузера сколь угодно долго, и участник смотрит на замерший таймер,
 * считая, что видит торги. Проверено обрывом связи в браузере.
 */
const SILENCE_LIMIT_MS = 8_000;

/** Как часто сторож проверяет тишину. */
const WATCHDOG_MS = 2_000;

export type ConnectionState = 'offline' | 'connecting' | 'online';

/** Отказ по собственной ставке — его видит только автор. */
export interface BidFeedback {
  readonly kind: 'accepted' | 'rejected';
  readonly code?: string;
  readonly at: number;
}

interface AuctionStore {
  readonly hall: HallState;
  readonly connection: ConnectionState;
  readonly feedback: BidFeedback | null;
  /** Через сколько сервер обещает снять паузу SLA Freeze. `null` — паузы нет. */
  readonly resumeInMs: number | null;
  /**
   * Действия объявлены свойствами-функциями, а не методами: метод, вырванный
   * из объекта (а селектор стора делает ровно это), теряет свой `this`.
   */
  readonly join: (lotId: string, wsUrl: string) => void;
  readonly leave: () => void;
  readonly placeBid: () => void;
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;
let attempt = 0;
let currentLot: string | null = null;
let currentUrl: string | null = null;

export const useAuctionStore = create<AuctionStore>((set, get) => {
  /** Переспросить снимок: вход в комнату идемпотентен и всегда присылает свежий. */
  function resync(): void {
    if (socket?.readyState === WebSocket.OPEN && currentLot !== null) {
      socket.send(JSON.stringify({ event: 'join_lot', lot_id: currentLot }));
    }
  }

  function handle(raw: unknown): void {
    // Из сокета приходят байты, а не наш тип: сужаем по полю event.
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const event = (raw as { event?: unknown }).event;

    if (event === 'ping') {
      socket?.send(JSON.stringify({ event: 'pong' }));
      return;
    }
    if (event === 'state_snapshot') {
      set({ hall: applySnapshot(raw as StateSnapshotEvent), connection: 'online' });
      return;
    }
    if (event === 'bid_updated') {
      set({ hall: applyBid(get().hall, raw as BidUpdatedEvent) });
      return;
    }
    if (event === 'timer_tick') {
      const result = applyTick(get().hall, raw as TimerTickEvent);
      set({ hall: result.state });
      if (result.resyncNeeded) {
        // Сервер знает о ставке, которой мы не видели: цена на кнопке уже
        // неверна, и досчитывать её самим нельзя.
        resync();
      }
      return;
    }
    if (event === 'auction_finished') {
      const finished = raw as { winner_blind_id?: string | null; final_price_kzt?: number };
      set({
        hall: {
          ...get().hall,
          status: 'FINISHED',
          timeRemainingMs: 0,
          winnerBlindId: finished.winner_blind_id ?? null,
          currentPriceTenge: finished.final_price_kzt ?? get().hall.currentPriceTenge,
        },
        resumeInMs: null,
      });
      return;
    }
    if (event === 'sla_freeze') {
      const freeze = raw as { time_remaining_ms?: number; resume_in_ms?: number };
      set({
        hall: {
          ...get().hall,
          status: 'FROZEN',
          // Остаток замирает на снимке: после паузы участник получит ровно то
          // время, что у него было, а не «сколько осталось по календарю».
          timeRemainingMs: freeze.time_remaining_ms ?? get().hall.timeRemainingMs,
        },
        resumeInMs: freeze.resume_in_ms ?? null,
      });
      return;
    }
    if (event === 'sla_resume') {
      const resume = raw as { time_remaining_ms?: number };
      set({
        hall: {
          ...get().hall,
          status: 'RUNNING',
          timeRemainingMs: resume.time_remaining_ms ?? get().hall.timeRemainingMs,
        },
        resumeInMs: null,
      });
      resync();
      return;
    }
    if (event === 'bid_accepted') {
      set({ feedback: { kind: 'accepted', at: performance.now() } });
      return;
    }
    if (event === 'bid_rejected' || event === 'error') {
      const code = (raw as { code?: unknown }).code;
      set({
        feedback: {
          kind: 'rejected',
          code: typeof code === 'string' ? code : 'UNKNOWN',
          at: performance.now(),
        },
      });
      // Цена могла уйти вперёд — переспрашиваем снимок, чтобы кнопка не
      // показывала сумму, которую сервер уже не примет.
      resync();
    }
  }

  function open(): void {
    if (currentUrl === null || currentLot === null) {
      return;
    }
    set({ connection: 'connecting' });

    const next = new WebSocket(currentUrl);
    socket = next;

    next.onopen = () => {
      attempt = 0;
      lastMessageAt = performance.now();
      // Токена в сообщении нет: браузер предъявляется кукой при рукопожатии.
      next.send(JSON.stringify({ event: 'join_lot', lot_id: currentLot }));
    };
    next.onmessage = (message: MessageEvent<string>) => {
      lastMessageAt = performance.now();
      try {
        handle(JSON.parse(message.data));
      } catch {
        // Кадр, который не разобрался, — не повод рвать соединение.
      }
    };
    next.onclose = () => {
      if (socket !== next) {
        return;
      }
      socket = null;
      set({ connection: 'offline' });
      scheduleReconnect();
    };
    next.onerror = () => {
      next.close();
    };
  }

  /**
   * Сторож тишины.
   *
   * Оборванный сокет остаётся «открытым» для браузера сколько угодно долго —
   * ни `close`, ни `error` не приходят. Без этой проверки участник смотрел бы
   * на замерший таймер, считая, что видит торги.
   */
  function startWatchdog(): void {
    if (watchdogTimer !== null) {
      return;
    }
    watchdogTimer = setInterval(() => {
      if (socket === null || currentLot === null) {
        return;
      }
      if (performance.now() - lastMessageAt > SILENCE_LIMIT_MS) {
        socket.close();
      }
    }, WATCHDOG_MS);
  }

  function scheduleReconnect(): void {
    if (currentLot === null || reconnectTimer !== null) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  return {
    hall: initialHall(''),
    connection: 'offline',
    feedback: null,
    resumeInMs: null,

    join: (lotId: string, wsUrl: string): void => {
      if (currentLot === lotId && socket !== null) {
        return;
      }
      currentLot = lotId;
      currentUrl = wsUrl;
      attempt = 0;
      set({ hall: initialHall(lotId), feedback: null });
      open();
      startWatchdog();
    },

    leave: (): void => {
      currentLot = null;
      currentUrl = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      socket?.close();
      socket = null;
      set({ connection: 'offline' });
    },

    /**
     * Отправить ставку.
     *
     * Сумма берётся из состояния — ровно та, что на кнопке. Сервер посчитает
     * свою и сверит: не совпало значит, что между отрисовкой и кликом успел
     * кто-то другой, и человек нажал не на ту цену, которую видел (QA-04).
     */
    placeBid: (): void => {
      const hall = get().hall;
      if (socket?.readyState !== WebSocket.OPEN || hall.nextPriceTenge <= 0) {
        return;
      }
      const message: PlaceBidMessage = {
        event: 'place_bid',
        lot_id: hall.lotId,
        amount_kzt: hall.nextPriceTenge,
      };
      socket.send(JSON.stringify(message));
    },
  };
});
