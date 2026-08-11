/**
 * Форматирование чисел.
 *
 * Своя группировка вместо Intl.NumberFormat намеренно: SSR и клиент обязаны
 * дать посимвольно одинаковый результат, иначе React ругается на расхождение
 * гидратации. Реализации ICU на сервере и в браузере различаются пробелами
 * (U+00A0 против U+202F), и это ровно тот случай.
 */

const NBSP = ' ';

/** 45000000 → «45 000 000» (неразрывные пробелы). */
export function groupDigits(value: number): string {
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(value)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${sign}${grouped}`;
}

/** 45000000 → «45 000 000 ₸». */
export function formatTenge(value: number): string {
  return `${groupDigits(value)}${NBSP}₸`;
}

/**
 * Следующий шаг торгов: +3 % с банковским округлением до целого тенге —
 * то же правило, что в CLAUDE.md §4.2 и в Lua-скрипте ставки (T-024).
 * Здесь оно только показывается; принимает ставку всегда сервер.
 */
export function nextBidTenge(currentTenge: number): number {
  const exact = currentTenge * 1.03;
  const floor = Math.floor(exact);
  const diff = exact - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Ровно .5 — к чётному.
  return floor % 2 === 0 ? floor : floor + 1;
}

const LOT_TYPE_LABEL = {
  REALTY: 'Недвижимость',
  VEHICLE: 'Транспорт',
} as const;

export function lotTypeLabel(type: 'REALTY' | 'VEHICLE'): string {
  return LOT_TYPE_LABEL[type];
}

/** Подпись номера объекта зависит от типа: кадастр или VIN. */
export function identifierLabel(type: 'REALTY' | 'VEHICLE'): string {
  return type === 'REALTY' ? 'Кадастровый номер' : 'VIN';
}
