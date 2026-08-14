import { describe, expect, it } from 'vitest';

import { SlaFreezeService } from './sla-freeze.service';

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
