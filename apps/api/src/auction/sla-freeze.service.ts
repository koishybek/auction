import { Injectable, Logger } from '@nestjs/common';

import {
  NotificationsService,
  TEMPLATE_SLA_FREEZE,
  TEMPLATE_SLA_RESUME,
} from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

import { AuctionStateService } from './auction-state.service';
import { BidService } from './bid.service';

/**
 * Порог деградации: заморозка при доле хуже связи СТРОГО больше 40 %.
 *
 * ТЗ §2.2 говорит «более чем у 40 %», поэтому ровно 40 % не замораживает —
 * на этом и построена приёмка (41 % морозит, 39 % нет).
 */
export const DEGRADED_SHARE_THRESHOLD = 0.4;

/** Хуже этой задержки соединение считается деградировавшим (ТЗ §2.2). */
export const DEGRADED_RTT_MS = 2_000;

/** Сколько длится пауза до автоматического возобновления (ТЗ §2.2). */
export const FREEZE_DURATION_MS = 60_000;

/**
 * Плохая ли связь у одного соединения (ТЗ §2.2).
 *
 * Отдельной чистой функцией, потому что здесь легко получить проверку, которая
 * не срабатывает никогда, и не заметить этого: до T-055 «ответа нет дольше
 * порога» считалось от времени отправки ping, которое обновлялось прямо перед
 * проверкой, — то есть всегда «сейчас». Заморозка при этом опиралась на
 * задержку ответа, а та у медленного клиента занижалась на целый такт
 * heartbeat, и участник с реальными 2.5 с выглядел здоровым.
 *
 * Три признака, любой достаточен:
 *   — на самый ранний неотвеченный ping ответа нет дольше порога;
 *   — последняя измеренная задержка хуже порога;
 *   — подряд пропущено больше одного такта.
 */
export function isDegradedLink(input: {
  readonly nowMs: number;
  readonly pendingPingAt: number | null;
  readonly rttMs: number | null;
  readonly missedPongs: number;
}): boolean {
  const waitingMs = input.pendingPingAt === null ? 0 : input.nowMs - input.pendingPingAt;
  return (
    waitingMs > DEGRADED_RTT_MS ||
    (input.rttMs !== null && input.rttMs > DEGRADED_RTT_MS) ||
    input.missedPongs > 1
  );
}

/**
 * SLA Freeze (T-032, FR-08).
 *
 * Смысл механизма — не наказать участников за плохую связь, а не дать
 * пятидесяти секундам утечь, пока половина зала не видит торгов. Массовая
 * деградация — это почти всегда сбой на нашей стороне или у провайдера, и
 * закрывать лот в такой момент значит продать его тому, у кого случайно
 * оказался лучше интернет.
 *
 * Пауза именно замораживает остаток, а не продлевает дедлайн: после
 * возобновления у участника ровно то время, что было, — ни больше ни меньше.
 */
@Injectable()
export class SlaFreezeService {
  private readonly logger = new Logger(SlaFreezeService.name);

  constructor(
    private readonly state: AuctionStateService,
    private readonly bids: BidService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Нужно ли замораживать при такой доле деградировавших.
   *
   * Вынесено отдельной функцией и проверяется юнит-тестом: граница «более 40 %»
   * — это то место, где легко разойтись на один клиент и заморозить торги,
   * которые в порядке.
   */
  static shouldFreeze(degraded: number, total: number): boolean {
    if (total === 0) {
      return false;
    }
    return degraded / total > DEGRADED_SHARE_THRESHOLD;
  }

  /** Заморозить торги. Возвращает снимок остатка или null, если морозить нечего. */
  async freeze(
    lotId: string,
    reason: string,
  ): Promise<{ remainingMs: number; resumeAtMs: number } | null> {
    const frozen = await this.state.freeze(lotId, FREEZE_DURATION_MS, this.bids.channel(lotId));
    if (frozen === null) {
      return null;
    }

    await this.prisma.auctionSession.updateMany({
      where: { lotId, status: 'RUNNING' },
      data: { status: 'FROZEN', freezeSnapshotMs: frozen.remainingMs },
    });

    /**
     * Приоритетное уведомление всем участникам (ТЗ §2.2).
     *
     * Человек в этот момент смотрит на замерший таймер и не знает почему.
     * Не сказать ему — значит оставить его думать, что торги сломались или
     * что его обманывают. Поэтому HIGH и поэтому всем сразу.
     */
    await this.notifications.notifyLotParticipants({
      lotId,
      template: TEMPLATE_SLA_FREEZE,
      priority: 'HIGH',
      params: {
        lot_id: lotId,
        time_remaining_ms: frozen.remainingMs,
        resume_in_ms: FREEZE_DURATION_MS,
      },
    });

    this.logger.warn(
      `Лот ${lotId}: SLA Freeze — ${reason}, остаток ${String(frozen.remainingMs)} мс`,
    );
    return frozen;
  }

  /** Возобновить торги. Возвращает восстановленный остаток или null. */
  async resume(lotId: string): Promise<{ remainingMs: number; deadlineMs: number } | null> {
    const resumed = await this.state.resume(lotId, this.bids.channel(lotId));
    if (resumed === null) {
      return null;
    }

    await this.prisma.auctionSession.updateMany({
      where: { lotId, status: 'FROZEN' },
      data: {
        status: 'RUNNING',
        freezeSnapshotMs: null,
        deadlineAt: new Date(resumed.deadlineMs),
      },
    });

    // О возобновлении сообщаем обычным приоритетом: таймер снова идёт, и это
    // видно на экране — паники, в отличие от заморозки, тут нет.
    await this.notifications.notifyLotParticipants({
      lotId,
      template: TEMPLATE_SLA_RESUME,
      params: { lot_id: lotId, time_remaining_ms: resumed.remainingMs },
    });

    this.logger.log(`Лот ${lotId}: торги возобновлены, остаток ${String(resumed.remainingMs)} мс`);
    return resumed;
  }

  /** Возобновить всё, чему пора. Вызывается воркером. */
  async resumeDue(nowMs: number): Promise<string[]> {
    const due = await this.state.dueForResume(nowMs);
    const resumed: string[] = [];
    for (const lotId of due) {
      if ((await this.resume(lotId)) !== null) {
        resumed.push(lotId);
      }
    }
    return resumed;
  }
}
