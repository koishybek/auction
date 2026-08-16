/**
 * Расщепление доплаты победителя (T-046, INT-03, ТЗ §5.2).
 *
 * Чистая функция без базы и без банка: это арифметика денег, и проверять её
 * нужно таблицей значений, а не поднятым приложением.
 *
 * Порядок долей задан ТЗ: сначала комиссия платформы, затем долг
 * залогодержателю, остаток — продавцу.
 */

/** Комиссия платформы — 5 % (ТЗ §5.2, ОВ-11). */
const PLATFORM_FEE_PERCENT = 5n;

export interface SplitInput {
  /** Сколько победитель фактически доплатил. */
  readonly paymentTiyn: bigint;
  /** Итоговая цена лота — база для комиссии. */
  readonly finalPriceTiyn: bigint;
  /** Долг залогодержателю. Ноль — объект не в залоге. */
  readonly lienDebtTiyn: bigint;
}

export interface SplitResult {
  readonly feeTiyn: bigint;
  readonly bankDebtTiyn: bigint;
  readonly sellerRestTiyn: bigint;
}

/**
 * Банковское округление до целого тенге — то же правило, что у шага цены и у
 * доли партнёра. Проценты в этой системе всегда становятся деньгами одинаково.
 */
function percentOf(amountTiyn: bigint, percent: bigint): bigint {
  const tenge = amountTiyn / 100n;
  const scaled = tenge * percent;
  let quotient = scaled / 100n;
  const remainder = scaled - quotient * 100n;

  if (remainder > 50n || (remainder === 50n && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return quotient * 100n;
}

/**
 * Посчитать доли.
 *
 * Остаток продавцу считается ВЫЧИТАНИЕМ, а не процентом. Это и есть гарантия
 * DoD «сумма долей равна платежу до тенге»: доли, посчитанные каждая своим
 * процентом, не сходятся на округлениях, и разница в пару тенге зависает
 * ничьей — а на денежном счёте ничьих сумм не бывает.
 *
 * Долг гасится не больше, чем осталось после комиссии: если долг превышает
 * доплату, продавец не получает ничего, но и уходить в минус система не может.
 * Такой случай — повод для человека, и он виден по нулевому остатку.
 */
export function splitPayment(input: SplitInput): SplitResult {
  if (input.paymentTiyn < 0n || input.finalPriceTiyn < 0n || input.lienDebtTiyn < 0n) {
    throw new RangeError('Отрицательные суммы в расщеплении недопустимы');
  }

  const feeTiyn = min(percentOf(input.finalPriceTiyn, PLATFORM_FEE_PERCENT), input.paymentTiyn);
  const afterFee = input.paymentTiyn - feeTiyn;
  const bankDebtTiyn = min(input.lienDebtTiyn, afterFee);
  const sellerRestTiyn = afterFee - bankDebtTiyn;

  return { feeTiyn, bankDebtTiyn, sellerRestTiyn };
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
