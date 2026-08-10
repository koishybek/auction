/**
 * Денежные примитивы.
 *
 * Правило проекта (CLAUDE.md §4.2): все суммы хранятся и считаются в ЦЕЛЫХ ТИЫНАХ
 * (1 тенге = 100 тиын) как `bigint`. Никаких float и никаких дробных `number`.
 *
 * Наружу (WS/REST) уходят ТЕНГЕ, потому что ТЗ §2.1 задаёт `current_price_kzt: 46350000`.
 * Конвертация делается только на границе — в сериализаторе.
 *
 * Арифметика ставки (+3 %, банковское округление до тенге) здесь НЕ живёт:
 * единственная точка изменения цены — Lua-скрипт в Redis (T-024).
 */

declare const tiynBrand: unique symbol;

/** Сумма в тиынах. Брендированный тип: обычный bigint сюда не присвоить без явной конверсии. */
export type Tiyn = bigint & { readonly [tiynBrand]: 'Tiyn' };

/** Тиынов в одном тенге. */
export const TIYN_PER_TENGE = 100n;

/** Собрать сумму из целого числа тиынов. */
export function tiyn(value: bigint): Tiyn {
  if (value < 0n) {
    throw new RangeError(`Отрицательная сумма недопустима: ${value.toString()} тиын`);
  }
  return value as Tiyn;
}

/** Собрать сумму из целого числа тенге. */
export function fromTenge(tenge: bigint): Tiyn {
  return tiyn(tenge * TIYN_PER_TENGE);
}

/**
 * Перевести в целые тенге для выдачи наружу.
 * Бросает, если сумма не кратна тенге: значит где-то нарушено правило округления шага.
 */
export function toTenge(amount: Tiyn): bigint {
  if (amount % TIYN_PER_TENGE !== 0n) {
    throw new RangeError(
      `Сумма ${amount.toString()} тиын не кратна тенге — нарушено правило округления шага`,
    );
  }
  return amount / TIYN_PER_TENGE;
}
