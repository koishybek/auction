import { describe, expect, it } from 'vitest';

import { splitPayment } from './splitter';

/**
 * Расщепление доплаты (T-046, INT-03).
 *
 * Главное свойство — суммы сходятся до тиына при любых входных данных. На
 * денежном счёте не бывает ничьих остатков: тенге, не попавший ни в одну
 * долю, — это тенге, о котором потом спорят.
 */
describe('T-046: Payment Splitter', () => {
  it('доли сходятся с платежом до тиына', () => {
    const result = splitPayment({
      paymentTiyn: 4_185_000_000n,
      finalPriceTiyn: 4_650_000_000n,
      lienDebtTiyn: 1_000_000_000n,
    });

    expect(result.feeTiyn + result.bankDebtTiyn + result.sellerRestTiyn).toBe(4_185_000_000n);
    // 5 % от 46 500 000 ₸ = 2 325 000 ₸.
    expect(result.feeTiyn).toBe(232_500_000n);
    expect(result.bankDebtTiyn).toBe(1_000_000_000n);
    expect(result.sellerRestTiyn).toBe(4_185_000_000n - 232_500_000n - 1_000_000_000n);
  });

  it('без залога весь остаток уходит продавцу', () => {
    const result = splitPayment({
      paymentTiyn: 900_000_00n,
      finalPriceTiyn: 1_000_000_00n,
      lienDebtTiyn: 0n,
    });

    expect(result.bankDebtTiyn).toBe(0n);
    expect(result.feeTiyn + result.sellerRestTiyn).toBe(900_000_00n);
  });

  it('долг больше доплаты — продавец не получает ничего, но минуса нет', () => {
    const result = splitPayment({
      paymentTiyn: 100_000_00n,
      finalPriceTiyn: 110_000_00n,
      lienDebtTiyn: 500_000_00n,
    });

    // Такой случай — повод для человека, и он виден по нулевому остатку.
    expect(result.sellerRestTiyn).toBe(0n);
    expect(result.feeTiyn + result.bankDebtTiyn).toBe(100_000_00n);
  });

  it('на любых суммах ничего не теряется и не появляется', () => {
    // Перебор специально «неудобных» чисел: округление комиссии не должно
    // оставлять ничьих тиынов.
    for (let priceTenge = 1_000_001n; priceTenge < 1_000_051n; priceTenge += 7n) {
      const finalPriceTiyn = priceTenge * 100n;
      const paymentTiyn = finalPriceTiyn - 99_913n * 100n;
      const result = splitPayment({ paymentTiyn, finalPriceTiyn, lienDebtTiyn: 3_777n * 100n });

      expect(result.feeTiyn + result.bankDebtTiyn + result.sellerRestTiyn).toBe(paymentTiyn);
      // Каждая доля кратна тенге: на провод уходят целые тенге.
      expect(result.feeTiyn % 100n).toBe(0n);
      expect(result.bankDebtTiyn % 100n).toBe(0n);
      expect(result.sellerRestTiyn % 100n).toBe(0n);
    }
  });

  it('отрицательные суммы отвергаются', () => {
    expect(() =>
      splitPayment({ paymentTiyn: -1n, finalPriceTiyn: 100n, lienDebtTiyn: 0n }),
    ).toThrow(RangeError);
  });
});
