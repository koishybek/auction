import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { DepositStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import {
  BIDDING_ALLOWED_FROM,
  checkTransition,
  transitionDescription,
  type DepositTransitionActor,
} from './deposit-status.machine';

/** Доля стартовой цены, которую участник вносит задатком (ТЗ, FR-12). */
export const DEPOSIT_SHARE_DIVISOR = 10n;

/**
 * Задатки (T-034, FR-12).
 *
 * Десять процентов стартовой цены на спецсчёте — пропуск к ставкам. Здесь
 * только учёт и статусы; сами платежи ходят через банк-адаптер (T-035), а
 * движок торгов о банках не знает вовсе (CLAUDE.md, раздел 3).
 */
@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  /**
   * Сколько нужно внести по этому лоту.
   *
   * Считается от СТАРТОВОЙ цены, а не от текущей: иначе сумма задатка росла бы
   * вместе с торгами, и участник, внёсший её утром, к вечеру оказался бы
   * недоплатившим.
   */
  async requiredAmountTiyn(lotId: string): Promise<bigint> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: lotId },
      select: { startPriceTiyn: true },
    });
    if (lot === null) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }
    return lot.startPriceTiyn / DEPOSIT_SHARE_DIVISOR;
  }

  /**
   * Завести задаток. Повторный вызов возвращает существующий: у пары
   * «участник + лот» задаток один, это ограничение базы, а не соглашение.
   */
  async open(input: { lotId: string; userId: string }): Promise<{
    id: string;
    status: DepositStatus;
    amountTiyn: bigint;
  }> {
    const existing = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId: input.userId, lotId: input.lotId } },
      select: { id: true, status: true, amountTiyn: true },
    });
    if (existing !== null) {
      return existing;
    }

    const amountTiyn = await this.requiredAmountTiyn(input.lotId);
    return this.prisma.deposit.create({
      data: { lotId: input.lotId, userId: input.userId, amountTiyn, status: 'PENDING' },
      select: { id: true, status: true, amountTiyn: true },
    });
  }

  /**
   * Сменить статус задатка.
   *
   * Единственная точка: правомерность решает таблица переходов, а не
   * вызывающий код. Обновление идёт со старым статусом в условии — две
   * конкурирующие смены не пройдут обе, вторая получит 409.
   */
  async transition(input: {
    depositId: string;
    to: DepositStatus;
    actor: DepositTransitionActor;
    actorId: string | null;
    reason?: string;
  }): Promise<DepositStatus> {
    const deposit = await this.prisma.deposit.findUnique({ where: { id: input.depositId } });
    if (deposit === null) {
      throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND' });
    }

    const check = checkTransition(deposit.status, input.to, input.actor);
    if (!check.allowed) {
      throw new ConflictException({ code: 'INVALID_DEPOSIT_TRANSITION', message: check.reason });
    }

    const result = await this.prisma.deposit.updateMany({
      where: { id: deposit.id, status: deposit.status },
      data: {
        status: input.to,
        // Возврат обязан уложиться в сутки (FR-12) — дедлайн ставится здесь,
        // чтобы воркер возвратов не вычислял его заново и не разошёлся с нами.
        ...(input.to === 'REFUND_PENDING'
          ? { refundDeadlineAt: new Date(this.time.wallClockMs() + REFUND_SLA_MS) }
          : {}),
      },
    });
    if (result.count === 0) {
      throw new ConflictException({
        code: 'INVALID_DEPOSIT_TRANSITION',
        message: 'Статус задатка изменился, повторите операцию',
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actor: input.actorId ?? input.actor,
        action: 'deposit.transition',
        entity: 'deposits',
        entityId: deposit.id,
        payloadJson: {
          from: deposit.status,
          to: input.to,
          asRole: input.actor,
          lotId: deposit.lotId,
          amountTiyn: deposit.amountTiyn.toString(),
          description: transitionDescription(deposit.status, input.to),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        serverTs: new Date(this.time.wallClockMs()),
      },
    });

    this.logger.log(`Задаток ${deposit.id}: ${deposit.status} → ${input.to} (${input.actor})`);
    return input.to;
  }

  /**
   * Допущен ли участник к ставкам по лоту.
   *
   * Ровно один статус даёт допуск, и проверяется он здесь, а не сравнением
   * строк по коду: разъехавшиеся условия означали бы участника, который
   * поднимает цену, не заплатив (FR-12).
   */
  async isAllowedToBid(userId: string, lotId: string): Promise<boolean> {
    const deposit = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId, lotId } },
      select: { status: true },
    });
    return deposit?.status === BIDDING_ALLOWED_FROM;
  }
}

/** Возврат проигравшим — в течение 24 часов после завершения торгов (FR-12). */
export const REFUND_SLA_MS = 24 * 60 * 60 * 1000;
