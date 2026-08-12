/**
 * Контракт торговой сессии между api, gateway и web.
 *
 * Ядро механики Smart Hammer 50s: шаг ровно +3 %, любая принятая ставка
 * возвращает таймер к 50 000 мс, 50 секунд тишины закрывают торги.
 */

/** Таймер Smart Hammer. Значение из ТЗ и не подлежит настройке через конфиг. */
export const SMART_HAMMER_TIMER_MS = 50_000;

/** Шаг ставки в процентах. Других шагов в системе нет. */
export const BID_STEP_PERCENT = 3;

export const SESSION_STATUSES = ['RUNNING', 'FROZEN', 'FINISHED'] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

/**
 * Снимок состояния торгов для клиента.
 *
 * Абсолютного дедлайна здесь нет намеренно: клиент получает остаток в
 * миллисекундах, а не момент времени (CLAUDE.md §4.3). Часы браузера не
 * участвуют ни в чём — иначе перевод системного времени на минуту назад
 * подарил бы участнику лишнюю минуту торгов.
 */
export interface AuctionStateView {
  readonly lotId: string;
  readonly sessionId: string;
  readonly status: SessionStatusValue;
  /** Текущая цена в целых тенге. Внутри системы — тиыны. */
  readonly currentPriceTenge: number;
  /** Номер последней принятой ставки. 0 — ставок ещё не было. */
  readonly seq: number;
  /** Сколько осталось до закрытия торгов. Никогда не отрицательно. */
  readonly timeRemainingMs: number;
  /** Серверное время снимка, мс эпохи. Только для диагностики и логов. */
  readonly serverTs: number;
}
