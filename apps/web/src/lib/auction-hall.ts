import type { BidUpdatedEvent, StateSnapshotEvent, TimerTickEvent } from '@auction/shared';

/**
 * Правила аукционного зала (T-039, FR-13).
 *
 * Без React и без сокета: это то, что должно проверяться тестом, а не глазами.
 * Компонент только рисует то, что решено здесь.
 */

/**
 * Цветовые зоны таймера (план, T-039): 50–20, 20–05, 05–00 секунд.
 *
 * Границы принадлежат ВЕРХНЕЙ зоне: ровно на двадцатой секунде участник ещё
 * не в тревоге. Иначе на границе цвет моргал бы туда-сюда от одного тика.
 */
export const TIMER_ZONE_WARNING_MS = 20_000;
export const TIMER_ZONE_CRITICAL_MS = 5_000;

export type TimerZone = 'calm' | 'warning' | 'critical';

export function timerZone(remainingMs: number): TimerZone {
  if (remainingMs >= TIMER_ZONE_WARNING_MS) {
    return 'calm';
  }
  if (remainingMs >= TIMER_ZONE_CRITICAL_MS) {
    return 'warning';
  }
  return 'critical';
}

/**
 * Таймер в формате СС:ммм — секунды и миллисекунды.
 *
 * Не «00:50», а «50.000»: у Smart Hammer вся драма в последних секундах, и
 * человеку нужно видеть, что счёт идёт, а не замер.
 */
export function formatTimer(remainingMs: number): string {
  const clamped = Math.max(0, remainingMs);
  const seconds = Math.floor(clamped / 1000);
  const millis = Math.floor(clamped % 1000);
  return `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Одна строка ленты. Реальных участников в ней нет — только псевдонимы (FR-09). */
export interface FeedEntry {
  readonly seq: number;
  readonly blindId: string;
  readonly priceTenge: number;
  readonly stepTenge: number;
  readonly timestamp: number;
}

export type HallStatus = 'CONNECTING' | 'RUNNING' | 'FROZEN' | 'FINISHED';

export interface HallState {
  readonly lotId: string;
  readonly status: HallStatus;
  readonly currentPriceTenge: number;
  /** Сумма следующей ставки — ровно её показывает кнопка и она же уходит на сервер. */
  readonly nextPriceTenge: number;
  readonly stepTenge: number;
  readonly timeRemainingMs: number;
  readonly seq: number;
  readonly feed: readonly FeedEntry[];
  /** Псевдоним победителя после закрытия торгов. */
  readonly winnerBlindId: string | null;
}

/** Сколько строк ленты держим. Больше на экран всё равно не помещается. */
const FEED_LIMIT = 20;

export function initialHall(lotId: string): HallState {
  return {
    lotId,
    status: 'CONNECTING',
    currentPriceTenge: 0,
    nextPriceTenge: 0,
    stepTenge: 0,
    timeRemainingMs: 0,
    seq: 0,
    feed: [],
    winnerBlindId: null,
  };
}

function entryOf(event: BidUpdatedEvent): FeedEntry {
  return {
    seq: event.seq,
    blindId: event.last_bidder_blind_id,
    priceTenge: event.current_price_kzt,
    stepTenge: event.bid_step_kzt,
    timestamp: event.timestamp,
  };
}

/**
 * Применить снимок состояния.
 *
 * Снимок затирает всё: он приходит при входе и после обрыва связи, и его смысл
 * ровно в том, чтобы не склеивать своё представление с чужим (T-030).
 */
export function applySnapshot(event: StateSnapshotEvent): HallState {
  return {
    lotId: event.lot_id,
    status: event.status,
    currentPriceTenge: event.current_price_kzt,
    nextPriceTenge: event.next_price_kzt,
    stepTenge: event.bid_step_kzt,
    timeRemainingMs: event.time_remaining_ms,
    seq: event.seq,
    feed: event.recent_bids.map(entryOf).slice(0, FEED_LIMIT),
    winnerBlindId: null,
  };
}

/**
 * Применить чужую (или свою) принятую ставку.
 *
 * Запоздавшее событие игнорируется по номеру: пакеты приходят не в том
 * порядке, в котором отправлены, и откат цены назад на кнопке означал бы
 * ставку не на ту сумму.
 *
 * Следующая цена считается сервером и приходит в снимке; между снимками её
 * приходится выводить из шага, потому что bid_updated её не несёт. Величина
 * шага в событии есть — она и складывается с новой ценой.
 */
export function applyBid(state: HallState, event: BidUpdatedEvent): HallState {
  if (event.seq <= state.seq) {
    return state;
  }
  return {
    ...state,
    status: 'RUNNING',
    currentPriceTenge: event.current_price_kzt,
    stepTenge: event.bid_step_kzt,
    nextPriceTenge: event.current_price_kzt + event.bid_step_kzt,
    timeRemainingMs: event.time_remaining_ms,
    seq: event.seq,
    feed: [entryOf(event), ...state.feed].slice(0, FEED_LIMIT),
  };
}

/**
 * Применить тик таймера.
 *
 * Остаток берётся с сервера как есть. Свой обратный отсчёт разошёлся бы с ним
 * на дрейф часов и на заморозку вкладки в фоне, а на пятидесяти секундах это
 * решает исход торгов (CLAUDE.md §4.3).
 *
 * Пропуск номера означает потерянную ставку — это сигнал переспросить снимок,
 * а не тихо продолжить с неверной ценой на кнопке.
 */
export function applyTick(
  state: HallState,
  event: TimerTickEvent,
): { readonly state: HallState; readonly resyncNeeded: boolean } {
  const next: HallState = { ...state, timeRemainingMs: event.time_remaining_ms };
  return { state: next, resyncNeeded: event.seq > state.seq };
}

/** Можно ли сейчас нажимать кнопку ставки. */
export function canBid(state: HallState, options: { authenticated: boolean }): boolean {
  return options.authenticated && state.status === 'RUNNING' && state.nextPriceTenge > 0;
}

/** Что написано на кнопке. Сумма — та же, что уйдёт на сервер. */
export function bidLabel(state: HallState): string {
  return `Сделать ставку +3 % · ${state.nextPriceTenge.toLocaleString('ru-KZ')} ₸`;
}

/**
 * Адрес сокета.
 *
 * Имя хоста берётся из адресной строки, а не из настройки. Причина не в
 * удобстве: сессия живёт в куке, а кука привязана к ИМЕНИ хоста и не смотрит
 * на порт. Открыв сайт как `localhost`, а сокет как `127.0.0.1`, участник
 * пришёл бы на gateway без куки — и получил бы отказ на ставке, глядя на
 * работающий таймер.
 *
 * Явно заданный полный адрес побеждает: за ingress'ом сокет живёт по своему
 * пути, а не по номеру порта.
 */
export function resolveWsUrl(
  configured: string | undefined,
  location: { protocol: string; hostname: string },
  port: string,
): string {
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname}:${port}`;
}
