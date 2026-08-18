import { describe, expect, it } from 'vitest';

import { DEGRADED_RTT_MS, isDegradedLink, SlaFreezeService } from './sla-freeze.service';

/**
 * Граница «более 40 %» (ТЗ §2.2, DoD T-032).
 *
 * Вынесено в юнит-тест намеренно: это то место, где легко разойтись на один
 * клиент. Ошибка в одну сторону замораживает торги, которые в порядке; в
 * другую — оставляет зал без связи доигрывать пятьдесят секунд.
 */
describe('SLA Freeze: порог деградации', () => {
  it('DoD: 41 % замораживает, 39 % — нет', () => {
    expect(SlaFreezeService.shouldFreeze(41, 100)).toBe(true);
    expect(SlaFreezeService.shouldFreeze(39, 100)).toBe(false);
  });

  it('ровно 40 % не замораживает: в ТЗ сказано «более чем»', () => {
    expect(SlaFreezeService.shouldFreeze(40, 100)).toBe(false);
    expect(SlaFreezeService.shouldFreeze(2, 5)).toBe(false);
    expect(SlaFreezeService.shouldFreeze(3, 5)).toBe(true);
  });

  it('пустой зал не замораживается', () => {
    // Деление на ноль дало бы NaN, а NaN > 0.4 это false — но полагаться на
    // это нельзя: отсутствие участников должно читаться явно.
    expect(SlaFreezeService.shouldFreeze(0, 0)).toBe(false);
  });

  it('все и никто', () => {
    expect(SlaFreezeService.shouldFreeze(0, 10)).toBe(false);
    expect(SlaFreezeService.shouldFreeze(10, 10)).toBe(true);
  });

  it('одиночный участник с плохой связью морозит лот целиком', () => {
    /**
     * Это буквальное следование ТЗ, и оно же — известный риск: «более 40 %
     * подключённых» при одном подключённом означает 100 %. На малолюдном лоте
     * один человек с плохим интернетом ставит торги на паузу для всех.
     *
     * Оставлено как в ТЗ сознательно: приёмка проверяет именно эту формулу.
     * Порог минимального числа участников — решение заказчика, а не наше.
     */
    expect(SlaFreezeService.shouldFreeze(1, 1)).toBe(true);
    expect(SlaFreezeService.shouldFreeze(1, 2)).toBe(true);
  });
});

/**
 * Признак плохой связи у одного соединения (T-055).
 *
 * Проверяется отдельно от доли, потому что сломаться здесь можно тихо: до
 * T-055 условие «ответа нет дольше порога» смотрело на время отправки ping,
 * которое обновлялось прямо перед проверкой, — и не срабатывало никогда.
 * Такт heartbeat — 2 с, порог деградации тоже 2 с, поэтому все случаи ниже
 * записаны в тактах.
 */
describe('SLA Freeze: связь одного соединения', () => {
  const TICK = 2_000;

  it('свежий ответ — связь здоровая', () => {
    expect(isDegradedLink({ nowMs: TICK, pendingPingAt: null, rttMs: 40, missedPongs: 0 })).toBe(
      false,
    );
  });

  it('стабильно медленный клиент считается деградировавшим', () => {
    /**
     * Ответ приходит через 2.5 с — то есть уже после следующего ping. Именно
     * этот случай раньше не распознавался: задержка считалась от последнего
     * ping и выходила 0.5 с, а пропуск такта сбрасывался тем же ответом.
     */
    expect(
      isDegradedLink({ nowMs: 4 * TICK, pendingPingAt: null, rttMs: 2_500, missedPongs: 0 }),
    ).toBe(true);
  });

  it('ровно порог — ещё не деградация', () => {
    // ТЗ §2.2 говорит «дольше 2000 мс»: граница принадлежит здоровой стороне.
    expect(
      isDegradedLink({ nowMs: 0, pendingPingAt: null, rttMs: DEGRADED_RTT_MS, missedPongs: 0 }),
    ).toBe(false);
    expect(
      isDegradedLink({ nowMs: DEGRADED_RTT_MS, pendingPingAt: 0, rttMs: null, missedPongs: 1 }),
    ).toBe(false);
  });

  it('молчащий клиент деградировал, даже если задержку измерить не успели', () => {
    // Ни одного ответа не было: rttMs неизвестен, но ping висит два такта.
    expect(isDegradedLink({ nowMs: 2 * TICK, pendingPingAt: 0, rttMs: null, missedPongs: 2 })).toBe(
      true,
    );
  });

  it('один пропущенный такт — ещё не деградация', () => {
    // Икота сети на одном такте не повод морозить зал: для этого есть порог.
    expect(isDegradedLink({ nowMs: TICK, pendingPingAt: TICK, rttMs: 30, missedPongs: 1 })).toBe(
      false,
    );
  });
});
