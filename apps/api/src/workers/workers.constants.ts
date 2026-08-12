import type { LotStatus } from '../generated/prisma/enums';

/** Очередь фоновых задач реестра (INT-02). */
export const REGISTRY_QUEUE = 'registry';

/** Обойти активные лоты и поставить по задаче на каждый. */
export const JOB_SWEEP = 'registry.sweep';

/** Перепроверить один лот в КИСИП/ЕРД. */
export const JOB_CHECK_LOT = 'registry.check-lot';

/** Идентификатор расписания: по нему BullMQ находит и обновляет крон. */
export const SCHEDULER_DAILY = 'registry.recheck.daily';

/**
 * Статусы, в которых лот перепроверяется.
 *
 * DRAFT и MODERATION не входят: лот ещё не размещён, а проверка при подаче уже
 * была (T-019). FINISHED, CLOSED, VETOED — торги позади, ограничение реестра
 * их не отменяет. PAUSED пропускаем: он уже остановлен, снимать паузу должен
 * человек, а не крон.
 */
export const RECHECKED_STATUSES: readonly LotStatus[] = ['PHASE_I', 'PHASE_II', 'PHASE_III'];

/**
 * Шаблоны уведомлений. Отправка появится вместе с адаптером Push/SMS (T-033);
 * пока строка записывается в notifications со статусом PENDING.
 */
export const TEMPLATE_LOT_PAUSED = 'lot.paused.registry_restriction';
export const TEMPLATE_RESTRICTION_DURING_BIDDING = 'lot.restriction_during_bidding';
