import type { DepositStatus } from '../generated/prisma/enums';

/**
 * Статусная машина задатка (T-034, FR-12).
 *
 * Задаток — это 10 % стартовой цены на спецсчёте, и каждый переход здесь
 * двигает чужие деньги. Поэтому правила живут таблицей, а не разбросанными
 * по сервисам условиями: новый переход = правка таблицы и юнит-теста, и его
 * видно в диффе.
 *
 * Жизненный путь:
 *   PENDING → HELD → ON_SPECIAL_ACCOUNT → REFUND_PENDING → REFUNDED
 * Боковые исходы: RUNNERUP_HOLD (второй участник ждёт своей очереди, FR-14)
 * и FORFEITED (задаток удержан).
 */

/** Кто двигает задаток. Инвестора здесь нет: своими деньгами он не распоряжается. */
export type DepositTransitionActor = 'BANK' | 'SYSTEM' | 'ADMIN';

interface TransitionRule {
  readonly to: DepositStatus;
  readonly actors: readonly DepositTransitionActor[];
  /** Зачем переход существует — уходит в audit_log. */
  readonly description: string;
}

const RULES: Readonly<Record<DepositStatus, readonly TransitionRule[]>> = {
  PENDING: [
    {
      to: 'HELD',
      actors: ['BANK'],
      description: 'Банк заблокировал сумму на карте участника',
    },
    {
      to: 'ON_SPECIAL_ACCOUNT',
      actors: ['BANK'],
      description: 'Деньги зачислены на спецсчёт — участник допущен к торгам',
    },
    {
      to: 'REFUND_PENDING',
      actors: ['SYSTEM', 'ADMIN'],
      description: 'Участник отказался до допуска либо лот снят',
    },
  ],
  HELD: [
    {
      to: 'ON_SPECIAL_ACCOUNT',
      actors: ['BANK'],
      description: 'Блокировка переведена на спецсчёт — участник допущен',
    },
    {
      to: 'REFUND_PENDING',
      actors: ['SYSTEM', 'ADMIN'],
      description: 'Блокировка снимается: участник отказался или лот снят',
    },
  ],
  ON_SPECIAL_ACCOUNT: [
    {
      to: 'REFUND_PENDING',
      actors: ['SYSTEM', 'ADMIN'],
      description: 'Торги завершены, участник не победил — возврат за 24 ч (FR-12)',
    },
    {
      to: 'RUNNERUP_HOLD',
      actors: ['SYSTEM'],
      description: 'Второе место: задаток удерживается на случай отказа победителя (FR-14)',
    },
    {
      to: 'FORFEITED',
      actors: ['SYSTEM', 'ADMIN'],
      description: 'Победитель не доплатил 90 % — задаток удержан',
    },
  ],
  RUNNERUP_HOLD: [
    {
      to: 'REFUND_PENDING',
      actors: ['SYSTEM', 'ADMIN'],
      description: 'Победитель расплатился, второй участник больше не нужен',
    },
    {
      to: 'FORFEITED',
      actors: ['SYSTEM', 'ADMIN'],
      description: 'Второй участник принял лот и сам не доплатил',
    },
  ],
  REFUND_PENDING: [
    {
      to: 'REFUNDED',
      actors: ['BANK'],
      description: 'Банк подтвердил возврат',
    },
    // Обратного пути в ON_SPECIAL_ACCOUNT намеренно нет: раз возврат запущен,
    // участник выбыл. Передумать — значит внести задаток заново, иначе
    // появляется способ вернуться в торги, когда исход уже известен.
  ],
  /**
   * Терминальные. Деньги ушли — со стороны системы менять нечего.
   * Ошибочный возврат или удержание правится новой записью и проводкой в
   * банке, а не переписыванием истории (CLAUDE.md §4.3).
   */
  REFUNDED: [],
  FORFEITED: [],
};

/**
 * Единственный статус, из которого участник допущен к ставкам (FR-12).
 *
 * Отдельной константой, а не строкой по коду: «допуск к деньгам» проверяется
 * в нескольких местах, и разъехавшиеся условия означали бы участника, который
 * ставит, не заплатив.
 */
export const BIDDING_ALLOWED_FROM: DepositStatus = 'ON_SPECIAL_ACCOUNT';

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Разрешён ли переход из `from` в `to` актору `actor`. */
export function checkTransition(
  from: DepositStatus,
  to: DepositStatus,
  actor: DepositTransitionActor,
): TransitionCheck {
  const rule = RULES[from].find((candidate) => candidate.to === to);
  if (!rule) {
    return { allowed: false, reason: `Переход задатка ${from} → ${to} не существует` };
  }
  if (!rule.actors.includes(actor)) {
    return { allowed: false, reason: `Переход задатка ${from} → ${to} недоступен роли ${actor}` };
  }
  return { allowed: true };
}

/** Описание перехода для audit_log. Вызывается только после checkTransition. */
export function transitionDescription(from: DepositStatus, to: DepositStatus): string {
  return RULES[from].find((rule) => rule.to === to)?.description ?? `${from} → ${to}`;
}

/** Все переходы, доступные актору из данного статуса. */
export function availableTransitions(
  from: DepositStatus,
  actor: DepositTransitionActor,
): readonly DepositStatus[] {
  return RULES[from].filter((rule) => rule.actors.includes(actor)).map((rule) => rule.to);
}

/** Полный список рёбер — для юнит-теста, который фиксирует таблицу целиком. */
export function allTransitions(): readonly { from: DepositStatus; to: DepositStatus }[] {
  return Object.entries(RULES).flatMap(([from, rules]) =>
    rules.map((rule) => ({ from: from as DepositStatus, to: rule.to })),
  );
}
