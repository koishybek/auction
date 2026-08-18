import { describe, expect, it } from 'vitest';

import { reconnectDelayMs } from './auction-store';

/**
 * Переподключение зала (T-055).
 *
 * Проверяется не «работает ли setTimeout», а то, что клиенты возвращаются
 * вразнобой. Массовый обрыв — это выкат gateway или моргнувший периметр, и
 * тогда отсчёт у всех начинается с одного и того же момента.
 */
describe('задержка переподключения', () => {
  it('растёт с попытками и упирается в потолок', () => {
    // Границы, а не точные значения: внутри окна задержка случайная.
    const first = reconnectDelayMs(0);
    expect(first).toBeGreaterThanOrEqual(350);
    expect(first).toBeLessThanOrEqual(650);

    const last = reconnectDelayMs(99);
    expect(last).toBeGreaterThanOrEqual(7_000);
    expect(last).toBeLessThanOrEqual(13_000);
  });

  it('две попытки одной волны не совпадают', () => {
    // Если бы разброса не было, тридцать тысяч клиентов вернулись бы одной
    // секундой — и выкат сам себе устроил бы нагрузочный тест.
    const delays = new Set(Array.from({ length: 20 }, () => reconnectDelayMs(2)));
    expect(delays.size).toBeGreaterThan(1);
  });
});
