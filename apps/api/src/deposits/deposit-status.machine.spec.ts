import { describe, expect, it } from 'vitest';

import type { DepositStatus } from '../generated/prisma/enums';

import {
  allTransitions,
  availableTransitions,
  BIDDING_ALLOWED_FROM,
  checkTransition,
  transitionDescription,
  type DepositTransitionActor,
} from './deposit-status.machine';

/**
 * Статусная машина задатка (T-034, FR-12).
 *
 * Каждый переход двигает чужие деньги, поэтому таблица фиксируется целиком:
 * тест обязан заметить не только сломанный переход, но и появление нового,
 * которого никто не обсуждал.
 */

const ALL_STATUSES: readonly DepositStatus[] = [
  'PENDING',
  'HELD',
  'ON_SPECIAL_ACCOUNT',
  'RUNNERUP_HOLD',
  'REFUND_PENDING',
  'REFUNDED',
  'FORFEITED',
];

const ACTORS: readonly DepositTransitionActor[] = ['BANK', 'SYSTEM', 'ADMIN'];

describe('T-034: статусная машина задатка', () => {
  it('таблица переходов зафиксирована целиком', () => {
    // Снимок: новый переход обязан пройти через правку этого списка, а значит
    // быть замеченным на ревью.
    expect(allTransitions()).toEqual([
      { from: 'PENDING', to: 'HELD' },
      { from: 'PENDING', to: 'ON_SPECIAL_ACCOUNT' },
      { from: 'PENDING', to: 'REFUND_PENDING' },
      { from: 'HELD', to: 'ON_SPECIAL_ACCOUNT' },
      { from: 'HELD', to: 'REFUND_PENDING' },
      { from: 'ON_SPECIAL_ACCOUNT', to: 'REFUND_PENDING' },
      { from: 'ON_SPECIAL_ACCOUNT', to: 'RUNNERUP_HOLD' },
      { from: 'ON_SPECIAL_ACCOUNT', to: 'FORFEITED' },
      { from: 'RUNNERUP_HOLD', to: 'REFUND_PENDING' },
      { from: 'RUNNERUP_HOLD', to: 'FORFEITED' },
      { from: 'REFUND_PENDING', to: 'REFUNDED' },
    ]);
  });

  it('DoD: каждый переход таблицы разрешён своему актору и описан', () => {
    for (const { from, to } of allTransitions()) {
      const allowedFor = ACTORS.filter((actor) => checkTransition(from, to, actor).allowed);
      expect(allowedFor.length, `${from} → ${to} не разрешён никому`).toBeGreaterThan(0);

      // Описание уходит в audit_log: переход без внятной причины — это запись
      // «деньги переставили», по которой ничего не восстановить.
      const description = transitionDescription(from, to);
      expect(description, `${from} → ${to} без описания`).not.toBe(`${from} → ${to}`);
      expect(description.length).toBeGreaterThan(10);
    }
  });

  it('переходов вне таблицы не существует ни для кого', () => {
    const declared = new Set(allTransitions().map(({ from, to }) => `${from}→${to}`));

    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (declared.has(`${from}→${to}`)) continue;
        for (const actor of ACTORS) {
          const check = checkTransition(from, to, actor);
          expect(check.allowed, `${from} → ${to} разрешён ${actor}, хотя не объявлен`).toBe(false);
          expect(check.reason).toContain('не существует');
        }
      }
    }
  });

  it('деньги на спецсчёт заводит только банк', () => {
    // Система не вправе объявить деньги поступившими: это подтверждает банк.
    for (const from of ['PENDING', 'HELD'] as const) {
      expect(checkTransition(from, 'ON_SPECIAL_ACCOUNT', 'BANK').allowed).toBe(true);
      expect(checkTransition(from, 'ON_SPECIAL_ACCOUNT', 'SYSTEM').allowed).toBe(false);
      expect(checkTransition(from, 'ON_SPECIAL_ACCOUNT', 'ADMIN').allowed).toBe(false);
    }
    expect(checkTransition('REFUND_PENDING', 'REFUNDED', 'BANK').allowed).toBe(true);
    expect(checkTransition('REFUND_PENDING', 'REFUNDED', 'ADMIN').allowed).toBe(false);
  });

  it('удержание второго участника назначает только система', () => {
    // Решение принимает finisher по итогу торгов, а не человек вручную (FR-14).
    expect(checkTransition('ON_SPECIAL_ACCOUNT', 'RUNNERUP_HOLD', 'SYSTEM').allowed).toBe(true);
    expect(checkTransition('ON_SPECIAL_ACCOUNT', 'RUNNERUP_HOLD', 'ADMIN').allowed).toBe(false);
    expect(checkTransition('ON_SPECIAL_ACCOUNT', 'RUNNERUP_HOLD', 'BANK').allowed).toBe(false);
  });

  it('из запущенного возврата дороги назад нет', () => {
    // Иначе появляется способ вернуться в торги, когда исход уже известен.
    expect(checkTransition('REFUND_PENDING', 'ON_SPECIAL_ACCOUNT', 'ADMIN').allowed).toBe(false);
    expect(checkTransition('REFUND_PENDING', 'RUNNERUP_HOLD', 'SYSTEM').allowed).toBe(false);
    expect(checkTransition('REFUND_PENDING', 'FORFEITED', 'SYSTEM').allowed).toBe(false);
  });

  it('возвращённый и удержанный задаток — терминальные состояния', () => {
    for (const terminal of ['REFUNDED', 'FORFEITED'] as const) {
      for (const actor of ACTORS) {
        expect(availableTransitions(terminal, actor)).toHaveLength(0);
      }
    }
  });

  it('допуск к ставкам даёт ровно один статус', () => {
    expect(BIDDING_ALLOWED_FROM).toBe('ON_SPECIAL_ACCOUNT');
    // Ни «оплачено», ни «заблокировано на карте» допуска не дают: деньги ещё
    // не там, где их можно списать в пользу продавца.
    expect(ALL_STATUSES.filter((s) => s === BIDDING_ALLOWED_FROM)).toHaveLength(1);
  });
});
