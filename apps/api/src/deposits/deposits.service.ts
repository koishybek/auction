import { toTenge, tiyn, type DepositView } from '@auction/shared';
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
 * Десять процентов стартовой цены с округлением ВВЕРХ до целого тенге.
 *
 * Округление нужно, потому что десятая часть цены в тиынах не обязана быть
 * кратной тенге: лот за 1005 ₸ даёт задаток 100,5 ₸, а наружу мы отдаём целые
 * тенге (CLAUDE.md §4.2) — такая сумма просто не представима на проводе.
 *
 * Вверх, а не банковским округлением, как у шага: шаг — это цена, где важна
 * симметрия, а задаток — гарантия. Недобор гарантийной суммы недопустим, а
 * лишний тенге вернётся участнику вместе с задатком.
 */
function depositAmountTiyn(startPriceTiyn: bigint): bigint {
  const perTenge = DEPOSIT_SHARE_DIVISOR * 100n;
  return ((startPriceTiyn + perTenge - 1n) / perTenge) * 100n;
}

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
    return depositAmountTiyn(lot.startPriceTiyn);
  }

  /**
   * Состояние задатка для интерфейса участника (T-036, FR-12).
   *
   * Допуск к торгам отдаётся отдельным полем, а не выводится из статуса в
   * браузере: правило допуска существует в одном экземпляре, на сервере.
   */
  async view(input: { lotId: string; userId: string }): Promise<DepositView> {
    const requiredAmountTiyn = await this.requiredAmountTiyn(input.lotId);
    const deposit = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId: input.userId, lotId: input.lotId } },
      select: { status: true, refundDeadlineAt: true },
    });

    return {
      lotId: input.lotId,
      status: deposit?.status ?? null,
      requiredAmountTenge: Number(toTenge(tiyn(requiredAmountTiyn))),
      allowedToBid: deposit?.status === BIDDING_ALLOWED_FROM,
      payUrl: null,
      refundRemainingMs: this.refundRemainingMs(deposit?.refundDeadlineAt ?? null),
    };
  }

  /**
   * Остаток SLA возврата. Отрицательного не бывает: просроченный возврат — это
   * ноль на табло и инцидент в воркере, а не таймер, идущий в минус.
   */
  private refundRemainingMs(deadline: Date | null): number | null {
    if (deadline === null) {
      return null;
    }
    return Math.max(0, deadline.getTime() - this.time.wallClockMs());
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
   * Открыть возвраты по завершённому лоту (T-037, INT-04).
   *
   * Возвращают всем, кто внёс задаток, кроме победителя: его деньги остаются
   * на спецсчёте и пойдут в зачёт доплаты либо будут удержаны. Runner-Up
   * (Опция А, FR-14) появится в T-038 — до него второй участник получает
   * возврат наравне с остальными.
   *
   * Переходы идут по одному через statusную машину, а не одним `updateMany`:
   * каждое движение задатка обязано оставить запись в audit_log, а массовое
   * обновление её не оставляет. Проигравших по лоту единицы-десятки, цена
   * такого цикла — ничто против пропавшего следа движения денег.
   *
   * Идемпотентно: повторный вызов не найдёт задатков в ON_SPECIAL_ACCOUNT.
   */
  async openRefundsForLot(lotId: string, winnerUserId: string | null): Promise<number> {
    const losers = await this.prisma.deposit.findMany({
      where: {
        lotId,
        status: BIDDING_ALLOWED_FROM,
        ...(winnerUserId === null ? {} : { userId: { not: winnerUserId } }),
      },
      select: { id: true },
    });

    let opened = 0;
    for (const deposit of losers) {
      try {
        await this.transition({
          depositId: deposit.id,
          to: 'REFUND_PENDING',
          actor: 'SYSTEM',
          actorId: null,
          reason: 'торги завершены, участник не победил',
        });
        opened += 1;
      } catch (error) {
        // Кто-то успел раньше (второй воркер, админ) — это не ошибка.
        // Молча пропускать нельзя: пропавший возврат виден только в логе.
        this.logger.warn(
          `Задаток ${deposit.id}: возврат не открыт — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (opened > 0) {
      this.logger.log(`Лот ${lotId}: открыто возвратов ${String(opened)}`);
    }
    return opened;
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
