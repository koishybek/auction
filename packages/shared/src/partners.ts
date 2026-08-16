import type { LotStatusValue } from './lots';

/** Контракт кабинета партнёра (FR-18). */

export const LEAD_STATUSES = ['FREE_CHECKED', 'LOCKED', 'EXPIRED', 'CONVERTED'] as const;
export type LeadStatusValue = (typeof LEAD_STATUSES)[number];

/**
 * Лид партнёра.
 *
 * Контакты собственника наружу не отдаются даже своему партнёру: он их и так
 * знает, а в ответе они превратились бы в ещё одну копию персональных данных,
 * которую нужно защищать (FR-09).
 */
export interface PartnerLeadView {
  readonly id: string;
  readonly cadastreOrVin: string;
  readonly status: LeadStatusValue;
  /** Сколько осталось до конца закрепления. `null` — закрепления нет. */
  readonly lockRemainingMs: number | null;
  /** Статус лота, если лид дошёл до площадки, — для прогресс-бара фаз. */
  readonly lotId: string | null;
  readonly lotStatus: LotStatusValue | null;
  readonly createdAt: string;
}

export interface PartnerLeadsView {
  readonly items: readonly PartnerLeadView[];
}

/** Отказ в регистрации лида. Код машинный, показывать надо словами. */
export const LEAD_REJECT_CODES = ['TAKEN', 'ALREADY_ON_PLATFORM'] as const;
export type LeadRejectCode = (typeof LEAD_REJECT_CODES)[number];
