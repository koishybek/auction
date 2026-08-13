/**
 * Протокол WebSocket между gateway и клиентами.
 *
 * Имена событий и структура — из ТЗ §2.1 и раздела 4 плана, поэтому здесь
 * snake_case, в отличие от REST-DTO. Это не небрежность: клиент заказчика
 * написан по ТЗ, и переименовывать поля «для единообразия» значит сломать
 * приёмку. Конверсия остаётся на границе.
 *
 * Деньги на проводе — целые ТЕНГЕ (`*_kzt`), как задано ТЗ. Внутри системы
 * тиыны; перевод делает тот же код, что считает цену.
 */

/** Клиент → сервер. */
export const CLIENT_EVENTS = ['join_lot', 'leave_lot', 'pong'] as const;
export type ClientEventName = (typeof CLIENT_EVENTS)[number];

/** Сервер → клиент. */
export const SERVER_EVENTS = [
  'state_snapshot',
  'bid_updated',
  'timer_tick',
  'auction_finished',
  'sla_freeze',
  'sla_resume',
  'ping',
  'error',
] as const;
export type ServerEventName = (typeof SERVER_EVENTS)[number];

/**
 * Снимок состояния торгов при входе в комнату и после переподключения.
 *
 * Абсолютного дедлайна нет: клиент получает остаток и серверную метку времени,
 * а свои часы в механике не использует (NFR-04).
 *
 * Хвост ленты ставок появится вместе с их персистом (T-028) — сейчас в снимке
 * только состояние.
 */
export interface StateSnapshotEvent {
  readonly event: 'state_snapshot';
  readonly lot_id: string;
  readonly session_id: string;
  readonly status: 'RUNNING' | 'FROZEN' | 'FINISHED';
  readonly current_price_kzt: number;
  /** Величина следующего шага, +3 % от текущей цены. */
  readonly bid_step_kzt: number;
  /** Абсолютная сумма следующей ставки — именно её клиент присылает в place_bid. */
  readonly next_price_kzt: number;
  readonly time_remaining_ms: number;
  readonly server_ts: number;
  /** Номер последней принятой ставки. 0 — ставок не было. */
  readonly seq: number;
  /**
   * Хвост ленты, свежие сверху.
   *
   * Нужен для переподключения (T-030): клиент, вернувшийся после обрыва, не
   * должен собирать пропущенное по кусочкам и не должен спрашивать отдельной
   * ручкой. Один снимок отвечает на всё: где цена, сколько осталось и что
   * произошло, пока связи не было.
   */
  readonly recent_bids: readonly BidUpdatedEvent[];
}

/** Событие принятой ставки. Структура дословно из ТЗ §2.1 плюс seq для ресинка. */
export interface BidUpdatedEvent {
  readonly event: 'bid_updated';
  readonly lot_id: string;
  readonly current_price_kzt: number;
  readonly bid_step_kzt: number;
  readonly last_bidder_blind_id: string;
  readonly time_remaining_ms: number;
  readonly timestamp: number;
  readonly seq: number;
  readonly session_id: string;
}

/**
 * Тик таймера, раз в 1000 мс (ТЗ §2.1, FR-02).
 *
 * `time_remaining_ms` уже посчитан сервером. Клиент его показывает, а не
 * пересчитывает: собственный обратный отсчёт разъедется с сервером на дрейф
 * часов и на заморозку вкладки в фоне, а на пятидесяти секундах это решает
 * исход торгов.
 */
export interface TimerTickEvent {
  readonly event: 'timer_tick';
  readonly lot_id: string;
  readonly time_remaining_ms: number;
  readonly server_ts: number;
  /** Номер последней принятой ставки — по нему клиент замечает пропуск. */
  readonly seq: number;
}

/** Отказ. Код машинный, message — для человека и логов. */
export interface WsErrorEvent {
  readonly event: 'error';
  readonly code: WsErrorCode;
  readonly message: string;
}

export const WS_ERROR_CODES = [
  /** Сообщение не разобралось или не прошло схему. */
  'BAD_MESSAGE',
  /** Токен предъявлен, но недействителен. */
  'INVALID_TOKEN',
  /** По лоту торги не идут. */
  'SESSION_NOT_FOUND',
  /** Слишком много комнат на одно соединение. */
  'TOO_MANY_ROOMS',
] as const;
export type WsErrorCode = (typeof WS_ERROR_CODES)[number];

/** Проверка живости соединения. На неё клиент отвечает `pong`. */
export interface PingEvent {
  readonly event: 'ping';
  readonly server_ts: number;
}
