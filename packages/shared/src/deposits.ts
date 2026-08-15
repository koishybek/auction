/** Контракт задатков между api и web (FR-12). */

export const DEPOSIT_STATUSES = [
  'PENDING',
  'HELD',
  'ON_SPECIAL_ACCOUNT',
  'RUNNERUP_HOLD',
  'REFUND_PENDING',
  'REFUNDED',
  'FORFEITED',
] as const;
export type DepositStatusValue = (typeof DEPOSIT_STATUSES)[number];

/**
 * Задаток участника по лоту на проводе.
 *
 * Деньги — целые ТЕНГЕ, как и везде на границе (CLAUDE.md §4.2).
 */
export interface DepositView {
  readonly lotId: string;
  /** `null` — задатка ещё нет: участник даже не запрашивал счёт. */
  readonly status: DepositStatusValue | null;
  /** Сколько нужно внести: 10 % стартовой цены. Известно и до открытия задатка. */
  readonly requiredAmountTenge: number;
  /**
   * Допущен ли участник к ставкам прямо сейчас.
   *
   * Отдельным полем, а не выводом из статуса на клиенте: правило допуска живёт
   * на сервере в одном экземпляре, и второй его экземпляр в браузере рано или
   * поздно разошёлся бы с первым.
   */
  readonly allowedToBid: boolean;
  /** Ссылка на оплату. Приходит в ответ на запрос счёта, при чтении статуса — `null`. */
  readonly payUrl: string | null;
  /**
   * Сколько осталось до срока авто-возврата (SLA 24 ч, FR-12).
   *
   * Остаток, а не абсолютное время: часы клиента не участвуют ни в чём
   * (CLAUDE.md §4.3). Возврат не запущен — `null`.
   */
  readonly refundRemainingMs: number | null;
}
