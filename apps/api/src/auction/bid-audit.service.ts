import type { BidRejectCode } from '@auction/shared';
import { Injectable, Logger } from '@nestjs/common';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TimeService } from '../time/time.service';

/** Шаблон уведомления администраторам о всплеске подмен суммы. */
export const TEMPLATE_BID_TAMPERING = 'security.bid_amount_tampering';

/**
 * Сколько отказов PRICE_MISMATCH по одному лоту за окно считается всплеском.
 *
 * Одиночные отказы — норма: между отрисовкой кнопки и кликом успевает чужая
 * ставка, и участник честно промахивается мимо цены. Десяток за минуту с
 * одного лота — уже не совпадение, а перебор сумм.
 */
const MISMATCH_ALERT_THRESHOLD = 10;

/** Окно подсчёта всплеска. */
const MISMATCH_WINDOW_SEC = 60;

/**
 * Коды, которые попадают в аудит.
 *
 * RATE_LIMITED здесь нет намеренно: автокликер даёт их сотнями, и запись
 * каждого в PostgreSQL превратила бы защиту от нагрузки в способ её создать.
 * Частота уже посчитана лимитером — в аудит идут попытки обойти ПРАВИЛА, а не
 * попытки нажать слишком часто.
 */
const AUDITED_CODES: readonly BidRejectCode[] = [
  'PRICE_MISMATCH',
  'SELF_OUTBID',
  'NO_DEPOSIT',
  'EGOV_NOT_VERIFIED',
  'SELLER_OWN_LOT',
  'USER_BLOCKED',
  'NOT_RUNNING',
  'TIMER_EXPIRED',
];

/**
 * Аудит отклонённых ставок (T-048, QA-04).
 *
 * Принятые ставки уже лежат в `bids` — append-only и с серверным временем;
 * дублировать их в audit_log незачем. Здесь записывается то, что ставкой не
 * стало: попытка прислать чужую сумму, поставить без задатка, перебить себя.
 * Именно это и есть след «security-теста из ТЗ §6» — по нему видно, что
 * подмену отклонили, а не просто она не сработала.
 *
 * Запись идёт мимо критического пути: приём ставки не должен ждать
 * PostgreSQL. Потерять запись об отказе неприятно, задержать приём ставки на
 * запись об отказе — хуже.
 */
@Injectable()
export class BidAuditService {
  private readonly logger = new Logger(BidAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly time: TimeService,
  ) {}

  /** Стоит ли писать этот отказ в аудит. */
  static isAudited(code: BidRejectCode): boolean {
    return AUDITED_CODES.includes(code);
  }

  /**
   * Записать отклонённую попытку.
   *
   * Вызывается без `await` из пути ставки: результат участнику уже отдан, и
   * ждать записи ему незачем. Ошибка записи гасится логом — она не должна
   * превращаться в отказ там, где отказ уже случился по другой причине.
   */
  record(input: {
    lotId: string;
    userId: string;
    code: BidRejectCode;
    /** Сумма, присланная участником, в тиынах. */
    sentAmountTiyn: bigint;
    /** Сумма, которую сервер посчитал сам. `null` — торги уже не идут. */
    serverAmountTiyn: bigint | null;
    ip: string | null;
    sessionId: string | null;
  }): void {
    void this.write(input).catch((error: unknown) => {
      this.logger.error(
        `Аудит отказа не записан: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async write(input: {
    lotId: string;
    userId: string;
    code: BidRejectCode;
    sentAmountTiyn: bigint;
    serverAmountTiyn: bigint | null;
    ip: string | null;
    sessionId: string | null;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actor: input.userId,
        action: 'bid.rejected',
        entity: 'lots',
        entityId: input.lotId,
        payloadJson: {
          code: input.code,
          // Суммы строками: в JSON bigint не сериализуется, а терять точность
          // на деньгах нельзя даже в аудите (CLAUDE.md §4.1).
          sentAmountTiyn: input.sentAmountTiyn.toString(),
          serverAmountTiyn: input.serverAmountTiyn?.toString() ?? null,
          ...(input.ip === null ? {} : { ip: input.ip }),
          ...(input.sessionId === null ? {} : { sessionId: input.sessionId }),
        },
        serverTs: new Date(this.time.wallClockMs()),
      },
    });

    if (input.code === 'PRICE_MISMATCH') {
      await this.countMismatch(input.lotId);
    }
  }

  /**
   * Счётчик подмен суммы по лоту.
   *
   * Живёт в Redis с коротким TTL, а не в PostgreSQL: это оперативный сигнал, а
   * не история. История уже записана строкой аудита.
   */
  private async countMismatch(lotId: string): Promise<void> {
    const key = this.redis.key('security', 'mismatch', lotId);
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, MISMATCH_WINDOW_SEC);
    }
    if (count !== MISMATCH_ALERT_THRESHOLD) {
      // Уведомляем ровно на пороге: иначе каждая следующая попытка в том же
      // окне порождала бы ещё одно сообщение админам.
      return;
    }

    this.logger.error(
      `Лот ${lotId}: ${String(count)} подмен суммы за ${String(MISMATCH_WINDOW_SEC)} с — ` +
        'похоже на перебор, а не на промах',
    );
    await this.alertAdmins(lotId, count);
  }

  private async alertAdmins(lotId: string, count: number): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'ADMIN' }, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify({
        userId: admin.id,
        template: TEMPLATE_BID_TAMPERING,
        priority: 'HIGH',
        params: { lot_id: lotId, count, window_sec: MISMATCH_WINDOW_SEC },
      });
    }
  }
}
