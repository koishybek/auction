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
      });
      return;
    }
    if (event === 'sla_freeze') {
      set({ hall: { ...get().hall, status: 'FROZEN' } });
      return;
    }
    if (event === 'sla_resume') {
      set({ hall: { ...get().hall, status: 'RUNNING' } });
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
      // Токена в сообщении нет: браузер предъявляется кукой при рукопожатии.
      next.send(JSON.stringify({ event: 'join_lot', lot_id: currentLot }));
    };
    next.onmessage = (message: MessageEvent<string>) => {
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

    join: (lotId: string, wsUrl: string): void => {
      if (currentLot === lotId && socket !== null) {
        return;
      }
      currentLot = lotId;
      currentUrl = wsUrl;
      attempt = 0;
      set({ hall: initialHall(lotId), feedback: null });
      open();
    },

    leave: (): void => {
      currentLot = null;
      currentUrl = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
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
