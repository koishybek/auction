import type { DepositStatusValue, DepositView } from '@auction/shared';

/**
 * Представление задатка в интерфейсе участника (T-036, FR-12).
 *
 * Отдельно от компонента и без React: это правила, а не разметка, и проверять
 * их нужно тестом, а не глазами. Единственное, чего здесь нет намеренно, —
 * решения «допущен ли участник к торгам»: его принимает сервер и присылает
 * готовым полем.
 */

export type DepositTone = 'idle' | 'waiting' | 'ready' | 'refund' | 'closed';

export interface DepositStage {
  /** Заголовок статуса — то, что человек читает первым. */
  readonly title: string;
  readonly tone: DepositTone;
  /** Что это значит и что делать дальше. */
  readonly note: string;
}

const STAGES: Readonly<Record<DepositStatusValue, DepositStage>> = {
  PENDING: {
    title: 'Ожидает оплаты',
    tone: 'waiting',
    note: 'Счёт выставлен. Ставки откроются, когда деньги дойдут до спецсчёта.',
  },
  HELD: {
    title: 'Заморожено',
    tone: 'waiting',
    note: 'Сумма заблокирована на карте. К торгам допускает только зачисление на спецсчёт.',
  },
  ON_SPECIAL_ACCOUNT: {
    title: 'На спецсчёте',
    tone: 'ready',
    note: 'Задаток внесён. Ставки по этому лоту открыты.',
  },
  RUNNERUP_HOLD: {
    title: 'Удерживается',
    tone: 'waiting',
    note: 'Вы второй участник. Задаток ждёт, пока победитель не рассчитается.',
  },
  REFUND_PENDING: {
    title: 'Возврат в работе',
    tone: 'refund',
    note: 'Поручение отправлено в банк. Срок возврата — 24 часа с завершения торгов.',
  },
  REFUNDED: {
    title: 'Возвращён',
    tone: 'closed',
    note: 'Деньги ушли на ваш счёт.',
  },
  FORFEITED: {
    title: 'Удержан',
    tone: 'closed',
    note: 'Задаток удержан по условиям торгов.',
  },
};

const NO_DEPOSIT: DepositStage = {
  title: 'Задаток не внесён',
  tone: 'idle',
  note: 'Без задатка на спецсчёте ставка не принимается — это правило торгов, а не формальность.',
};

export function depositStage(status: DepositStatusValue | null): DepositStage {
  return status === null ? NO_DEPOSIT : STAGES[status];
}

/**
 * Ждём ли мы сейчас ответа банка.
 *
 * Пока ждём — виджет опрашивает сервер: платёж подтверждает банк отдельным
 * вебхуком, и момент его прихода нам заранее неизвестен. В остальных статусах
 * опрос прекращается: держать запросы ради статуса, который уже не изменится,
 * значит греть сервер впустую.
 */
export function awaitsBank(status: DepositStatusValue | null): boolean {
  return status === 'PENDING' || status === 'HELD';
}

/** Есть ли что показывать на таймере SLA. */
export function hasRefundCountdown(view: DepositView): boolean {
  return view.refundRemainingMs !== null;
}

/**
 * Остаток SLA после `elapsedMs` монотонных миллисекунд с момента ответа сервера.
 *
 * Часы браузера в расчёте не участвуют: сервер присылает остаток, клиент
 * вычитает из него прошедшее время (CLAUDE.md §4.3). Ниже нуля не опускаемся —
 * просроченный возврат это ноль на табло и инцидент на сервере.
 */
export function remainingAfter(serverRemainingMs: number, elapsedMs: number): number {
  return Math.max(0, serverRemainingMs - elapsedMs);
}

/** Остаток в виде ЧЧ:ММ:СС. Сутки SLA в часы укладываются, суток на табло нет. */
export function formatRemaining(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}
