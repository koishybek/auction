import type { LotStatusValue } from './lots';

/** Контракт Ref-Bonus (FR-19). */

export const REF_BONUS_STATUSES = ['FORECAST', 'ACCRUED', 'PAID'] as const;
export type RefBonusStatusValue = (typeof REF_BONUS_STATUSES)[number];

/**
 * Доля партнёра по одному лоту.
 *
 * `FORECAST` считается от текущей цены при каждом запросе и нигде не хранится:
 * пока торги идут, любое сохранённое число устаревает следующей ставкой.
 */
export interface RefBonusView {
  readonly lotId: string;
  readonly cadastreOrVin: string;
  readonly lotStatus: LotStatusValue;
  readonly amountTenge: number;
  readonly status: RefBonusStatusValue;
  readonly updatedAt: string;
}

export interface RefBonusesView {
  readonly items: readonly RefBonusView[];
}
