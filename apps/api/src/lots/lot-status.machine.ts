import type { LotStatus, UserRole } from '../generated/prisma/enums';

/**
 * Статусная машина лота (T-015).
 *
 * Жизненный цикл из раздела 4 плана:
 *   DRAFT → MODERATION → PHASE_I → PHASE_II → PHASE_III → FINISHED → CLOSED
 * Плюс боковые состояния: PAUSED (ограничение из ЕРД, INT-02) и VETOED (FR-17).
 *
 * Таблица — единственный источник истины о переходах. Сервис не решает сам,
 * можно ли перейти, — он спрашивает таблицу. Новый переход = правка таблицы
 * и юнит-теста, а не if где-то в сервисе.
 */

export type LotTransitionActor = UserRole | 'SYSTEM';

interface TransitionRule {
  readonly to: LotStatus;
  /** Кто вправе инициировать переход. SYSTEM — воркеры и интеграции. */
  readonly actors: readonly LotTransitionActor[];
  /** Зачем переход существует — уходит в audit_log. */
  readonly description: string;
}

const RULES: Readonly<Record<LotStatus, readonly TransitionRule[]>> = {
  DRAFT: [
    {
      to: 'MODERATION',
      actors: ['SELLER', 'ADMIN'],
      description: 'Продавец отправил лот на модерацию',
    },
  ],
  MODERATION: [
    { to: 'PHASE_I', actors: ['ADMIN'], description: 'Модерация пройдена, лот размещён' },
    { to: 'DRAFT', actors: ['ADMIN'], description: 'Возвращён на доработку' },
  ],
  PHASE_I: [
    {
      to: 'PHASE_II',
      actors: ['ADMIN', 'SYSTEM'],
      description: 'Проверки пройдены: маркетинг, Open House, сбор задатков',
    },
    { to: 'PAUSED', actors: ['ADMIN', 'SYSTEM'], description: 'Ограничение из КИСИП/ЕРД' },
  ],
  PHASE_II: [
    { to: 'PHASE_III', actors: ['ADMIN', 'SYSTEM'], description: 'Старт торгов' },
    { to: 'PAUSED', actors: ['ADMIN', 'SYSTEM'], description: 'Ограничение из КИСИП/ЕРД' },
  ],
  PHASE_III: [
    {
      to: 'FINISHED',
      actors: ['SYSTEM'],
      description: 'Smart Hammer: 50 секунд тишины, торги завершены',
    },
    // PAUSED из PHASE_III намеренно НЕТ: остановка живых торгов — это SLA Freeze
    // (FR-08, внутри Phase 3), а не смена статуса лота. Иначе появились бы два
    // конкурирующих механизма паузы с разной семантикой.
  ],
  FINISHED: [
    {
      to: 'CLOSED',
      actors: ['SELLER', 'SYSTEM'],
      description: 'Продавец подтвердил сделку (или истёк срок ВЕТО)',
    },
    { to: 'VETOED', actors: ['SELLER'], description: 'Право ВЕТО: сделка отклонена (FR-17)' },
  ],
  PAUSED: [
    {
      to: 'PHASE_I',
      actors: ['ADMIN', 'SYSTEM'],
      description: 'Ограничение снято, лот возвращён к проверкам',
    },
    { to: 'CLOSED', actors: ['ADMIN'], description: 'Лот снят с торгов из-за ограничения' },
  ],
  // Терминальные: из VETOED лот не возвращается — после карантина (lockout 5 мес)
  // создаётся НОВЫЙ лот, история старого неприкосновенна.
  VETOED: [],
  CLOSED: [],
};

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Разрешён ли переход из `from` в `to` актору `actor`. */
export function checkTransition(
  from: LotStatus,
  to: LotStatus,
  actor: LotTransitionActor,
): TransitionCheck {
  const rule = RULES[from].find((candidate) => candidate.to === to);
  if (!rule) {
    return {
      allowed: false,
      reason: `Переход ${from} → ${to} не существует`,
    };
  }
  if (!rule.actors.includes(actor)) {
    return {
      allowed: false,
      reason: `Переход ${from} → ${to} недоступен роли ${actor}`,
    };
  }
  return { allowed: true };
}

/** Все переходы, доступные актору из данного статуса, — для кнопок в UI. */
export function availableTransitions(
  from: LotStatus,
  actor: LotTransitionActor,
): readonly LotStatus[] {
  return RULES[from].filter((rule) => rule.actors.includes(actor)).map((rule) => rule.to);
}

/** Описание перехода для audit_log. Вызывается только после checkTransition. */
export function transitionDescription(from: LotStatus, to: LotStatus): string {
  return RULES[from].find((rule) => rule.to === to)?.description ?? `${from} → ${to}`;
}

/** Полный список рёбер — для юнит-теста, который фиксирует таблицу целиком. */
export function allTransitions(): readonly { from: LotStatus; to: LotStatus }[] {
  return Object.entries(RULES).flatMap(([from, rules]) =>
    rules.map((rule) => ({ from: from as LotStatus, to: rule.to })),
  );
}
