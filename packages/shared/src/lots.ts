/** Контракт лотов между api и web. */

export const LOT_TYPES = ['REALTY', 'VEHICLE'] as const;
export type LotType = (typeof LOT_TYPES)[number];

export const LOT_STATUSES = [
  'DRAFT',
  'MODERATION',
  'PHASE_I',
  'PHASE_II',
  'PHASE_III',
  'FINISHED',
  'CLOSED',
  'PAUSED',
  'VETOED',
] as const;
export type LotStatusValue = (typeof LOT_STATUSES)[number];

/** Статусы, в которых лот виден всем в каталоге. */
export const PUBLIC_LOT_STATUSES: readonly LotStatusValue[] = [
  'PHASE_I',
  'PHASE_II',
  'PHASE_III',
  'FINISHED',
];

/**
 * Лот на проводе. Деньги — целые ТЕНГЕ (ТЗ §2.1 задаёт *_kzt в тенге);
 * внутри системы всё в тиынах, конверсия на границе сериализации.
 */
export interface LotView {
  readonly id: string;
  readonly type: LotType;
  readonly cadastreOrVin: string;
  readonly status: LotStatusValue;
  /**
   * Витрина объекта. Всё необязательное: лот заводится раньше, чем собраны
   * материалы, и пустая карточка честнее отказа в подаче.
   *
   * Кадастровый номер и VIN объект ИДЕНТИФИЦИРУЮТ, но выбрать по ним нельзя —
   * каталог из одних номеров выглядит выгрузкой из реестра, а не витриной.
   */
  readonly title: string | null;
  readonly address: string | null;
  readonly description: string | null;
  /** Площадь в сотых квадратного метра: целое, как и деньги в тиынах. */
  readonly areaSqmX100: number | null;
  readonly mileageKm: number | null;
  readonly buildYear: number | null;
  readonly startPriceTenge: number;
  readonly currentPriceTenge: number | null;
  readonly sellerId: string;
  /**
   * Просмотры карточки. `null` — смотрящему эта цифра не положена: интерес к
   * лоту видят только владелец и админ, конкуренты по торгам — нет.
   */
  readonly viewsCount: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LotListView {
  readonly items: readonly LotView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
