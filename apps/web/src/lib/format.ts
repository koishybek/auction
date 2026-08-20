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
 * Следующий шаг торгов для ВИТРИНЫ лота, по которому торги ещё не начались:
 * +3 % с банковским округлением до целого тенге.
 *
 * Только для показа «во что обойдётся клик» до старта торгов — сессии ещё нет,
 * и спросить сервер не у кого. Как только торги идут, сумма шага берётся из
 * снимка состояния (`nextBidTenge` в AuctionStateView): её считает Redis тем же
 * кодом, что и приём ставки. Считать её здесь и отправлять на сервер нельзя —
 * сервер сверяет сумму со своей (QA-04), и расхождение в последнем тенге
 * означало бы отказ на честно посчитанной ставке.
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

/** Площадь из сотых квадратного метра: 6240 → «62,4 м²». */
export function formatArea(areaSqmX100: number): string {
  const whole = Math.floor(areaSqmX100 / 100);
  const fraction = areaSqmX100 % 100;
  const tail = fraction === 0 ? '' : `,${String(Math.round(fraction / 10))}`;
  return `${whole.toLocaleString('ru-KZ')}${tail} м²`;
}

/** Пробег: 84 000 → «84 000 км». */
export function formatMileage(mileageKm: number): string {
  return `${mileageKm.toLocaleString('ru-KZ')} км`;
}

/**
 * Короткая строка характеристик объекта для карточки каталога.
 *
 * Только то, что заполнено: пустых прочерков в списке быть не должно — они
 * читаются как «данных нет и не будет», а данные просто ещё не собраны.
 */
export function objectFacts(lot: {
  type: 'REALTY' | 'VEHICLE';
  areaSqmX100: number | null;
  mileageKm: number | null;
  buildYear: number | null;
}): string {
  const facts: string[] = [];
  if (lot.areaSqmX100 !== null) facts.push(formatArea(lot.areaSqmX100));
  if (lot.mileageKm !== null) facts.push(formatMileage(lot.mileageKm));
  if (lot.buildYear !== null) {
    facts.push(
      lot.type === 'REALTY' ? `${String(lot.buildYear)} г. постройки` : String(lot.buildYear),
    );
  }
  return facts.join(' · ');
}
