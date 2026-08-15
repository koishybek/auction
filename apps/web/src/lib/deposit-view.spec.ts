import { DEPOSIT_STATUSES } from '@auction/shared';
import { describe, expect, it } from 'vitest';

import { awaitsBank, depositStage, formatRemaining, remainingAfter } from './deposit-view';

describe('T-036: представление задатка', () => {
  it('у каждого статуса есть свой заголовок', () => {
    const titles = DEPOSIT_STATUSES.map((status) => depositStage(status).title);
    // Одинаковые подписи у разных статусов означали бы участника, который не
    // понимает, допущен он к торгам или нет.
    expect(new Set(titles).size).toBe(DEPOSIT_STATUSES.length);
  });

  it('ТЗ-формулировки статусов на месте', () => {
    expect(depositStage('HELD').title).toBe('Заморожено');
    expect(depositStage('ON_SPECIAL_ACCOUNT').title).toBe('На спецсчёте');
    expect(depositStage(null).tone).toBe('idle');
  });

  it('к торгам допускает ровно один статус', () => {
    const ready = DEPOSIT_STATUSES.filter((status) => depositStage(status).tone === 'ready');
    expect(ready).toEqual(['ON_SPECIAL_ACCOUNT']);
  });

  it('опрос идёт, только пока ждём банк', () => {
    expect(awaitsBank('PENDING')).toBe(true);
    expect(awaitsBank('HELD')).toBe(true);
    expect(awaitsBank('ON_SPECIAL_ACCOUNT')).toBe(false);
    expect(awaitsBank('REFUNDED')).toBe(false);
    // Задатка нет — ждать нечего, счёт ещё не выставляли.
    expect(awaitsBank(null)).toBe(false);
  });

  it('таймер SLA считает от серверного остатка и не уходит в минус', () => {
    expect(remainingAfter(24 * 3600 * 1000, 0)).toBe(86_400_000);
    expect(remainingAfter(10_000, 3_000)).toBe(7_000);
    expect(remainingAfter(1_000, 5_000)).toBe(0);
  });

  it('остаток печатается как ЧЧ:ММ:СС', () => {
    expect(formatRemaining(24 * 3600 * 1000)).toBe('24:00:00');
    expect(formatRemaining(23 * 3600 * 1000 + 59 * 60 * 1000 + 12 * 1000)).toBe('23:59:12');
    expect(formatRemaining(999)).toBe('00:00:00');
    expect(formatRemaining(-5)).toBe('00:00:00');
  });
});
