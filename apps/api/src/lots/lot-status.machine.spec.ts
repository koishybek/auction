import { describe, expect, it } from 'vitest';

import type { LotStatus } from '../generated/prisma/enums';

import {
  allTransitions,
  availableTransitions,
  checkTransition,
  transitionDescription,
} from './lot-status.machine';

const ALL_STATUSES: readonly LotStatus[] = [
  'DRAFT',
  'MODERATION',
  'PHASE_I',
  'PHASE_II',
  'PHASE_III',
  'FINISHED',
  'CLOSED',
  'PAUSED',
  'VETOED',
];

describe('таблица переходов лота', () => {
  it('фиксирует полный набор рёбер — правка таблицы без правки теста невозможна', () => {
    // Это снимок бизнес-правил из раздела 4 плана. Если тест упал — либо
    // таблицу меняли осознанно (обнови снимок), либо сломали случайно.
    const edges = allTransitions()
      .map(({ from, to }) => `${from}→${to}`)
      .sort();
    expect(edges).toEqual(
      [
        'DRAFT→MODERATION',
        'MODERATION→PHASE_I',
        'MODERATION→DRAFT',
        'PHASE_I→PHASE_II',
        'PHASE_I→PAUSED',
        'PHASE_II→PHASE_III',
        'PHASE_II→PAUSED',
        'PHASE_III→FINISHED',
        'FINISHED→CLOSED',
        'FINISHED→VETOED',
        'PAUSED→PHASE_I',
        'PAUSED→CLOSED',
      ].sort(),
    );
  });

  it('основной жизненный цикл проходится целиком', () => {
    expect(checkTransition('DRAFT', 'MODERATION', 'SELLER').allowed).toBe(true);
    expect(checkTransition('MODERATION', 'PHASE_I', 'ADMIN').allowed).toBe(true);
    expect(checkTransition('PHASE_I', 'PHASE_II', 'SYSTEM').allowed).toBe(true);
    expect(checkTransition('PHASE_II', 'PHASE_III', 'SYSTEM').allowed).toBe(true);
    expect(checkTransition('PHASE_III', 'FINISHED', 'SYSTEM').allowed).toBe(true);
    expect(checkTransition('FINISHED', 'CLOSED', 'SELLER').allowed).toBe(true);
  });

  it('несуществующий переход запрещён всем, включая админа и систему', () => {
    for (const actor of ['ADMIN', 'SYSTEM', 'SELLER', 'INVESTOR', 'PARTNER'] as const) {
      expect(checkTransition('DRAFT', 'PHASE_III', actor).allowed).toBe(false);
      expect(checkTransition('CLOSED', 'DRAFT', actor).allowed).toBe(false);
      expect(checkTransition('VETOED', 'PHASE_I', actor).allowed).toBe(false);
    }
  });

  it('терминальные статусы не имеют выходов', () => {
    for (const from of ['VETOED', 'CLOSED'] as const) {
      for (const to of ALL_STATUSES) {
        expect(checkTransition(from, to, 'ADMIN').allowed).toBe(false);
      }
    }
  });

  it('роль ограничивает переход: инвестор не двигает лоты вообще', () => {
    for (const { from, to } of allTransitions()) {
      expect(checkTransition(from, to, 'INVESTOR').allowed).toBe(false);
      expect(checkTransition(from, to, 'PARTNER').allowed).toBe(false);
    }
  });

  it('завершить торги может только система — не админ и не продавец', () => {
    expect(checkTransition('PHASE_III', 'FINISHED', 'SYSTEM').allowed).toBe(true);
    expect(checkTransition('PHASE_III', 'FINISHED', 'ADMIN').allowed).toBe(false);
    expect(checkTransition('PHASE_III', 'FINISHED', 'SELLER').allowed).toBe(false);
  });

  it('ВЕТО доступно только продавцу (FR-17)', () => {
    expect(checkTransition('FINISHED', 'VETOED', 'SELLER').allowed).toBe(true);
    expect(checkTransition('FINISHED', 'VETOED', 'ADMIN').allowed).toBe(false);
    expect(checkTransition('FINISHED', 'VETOED', 'SYSTEM').allowed).toBe(false);
  });

  it('из PHASE_III нет паузы — остановка живых торгов это SLA Freeze, не статус лота', () => {
    expect(checkTransition('PHASE_III', 'PAUSED', 'ADMIN').allowed).toBe(false);
    expect(checkTransition('PHASE_III', 'PAUSED', 'SYSTEM').allowed).toBe(false);
  });

  it('отказ всегда объясняет причину', () => {
    const noEdge = checkTransition('DRAFT', 'CLOSED', 'ADMIN');
    expect(noEdge.reason).toMatch(/не существует/);
    const wrongActor = checkTransition('DRAFT', 'MODERATION', 'INVESTOR');
    expect(wrongActor.reason).toMatch(/недоступен роли/);
  });

  it('availableTransitions отдаёт кнопки для UI по роли', () => {
    expect(availableTransitions('FINISHED', 'SELLER')).toEqual(['CLOSED', 'VETOED']);
    expect(availableTransitions('FINISHED', 'INVESTOR')).toEqual([]);
    expect(availableTransitions('MODERATION', 'ADMIN')).toEqual(['PHASE_I', 'DRAFT']);
  });

  it('у каждого перехода есть описание для audit_log', () => {
    for (const { from, to } of allTransitions()) {
      expect(transitionDescription(from, to).length).toBeGreaterThan(5);
    }
  });
});
