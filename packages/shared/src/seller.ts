import type { LotStatusValue, LotType } from './lots';

/** Контракт кабинета продавца (FR-15, FR-16). */

/**
 * Лот глазами владельца — с цифрами, которых не видит никто другой.
 *
 * Смысл монитора прозрачности в том, чтобы продавец видел интерес к лоту сам,
 * а не со слов площадки: сколько раз открывали карточку, сколько раз скачивали
 * документы, сколько человек записались на показ.
 */
export interface SellerLotView {
  readonly id: string;
  readonly type: LotType;
  readonly cadastreOrVin: string;
  readonly status: LotStatusValue;
  readonly startPriceTenge: number;
  readonly currentPriceTenge: number | null;
  /** Просмотры карточки, включая ещё не сброшенные в базу. */
  readonly viewsCount: number;
  readonly documentsCount: number;
  /** Сколько раз скачивали документы Data Room суммарно. */
  readonly downloadsCount: number;
  readonly openHouseSlots: number;
  readonly openHouseBookings: number;
  /** Принятых ставок. Во время торгов растёт на глазах. */
  readonly bidsCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SellerDashboardView {
  readonly items: readonly SellerLotView[];
}
