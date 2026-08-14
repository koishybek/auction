import type { BidDenyCode, BidRejectCode } from '@auction/shared';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { BidService, type BidOutcome } from './bid.service';
import { BidRateLimitService } from './bid-rate-limit.service';
import { BlindIdService } from './blind-id.service';

/** Результат полного пути ставки: пред-проверки плюс атомарное ядро. */
export type PlacementResult =
  | { readonly status: 'ACCEPTED'; readonly seq: number; readonly priceTenge: number }
  | {
      readonly status: 'REJECTED';
      readonly code: BidRejectCode;
      /** Через сколько мс можно повторить. Заполняется только для RATE_LIMITED. */
      readonly retryAfterMs?: number;
    };

/**
 * Право поставить и сама ставка (T-025).
 *
 * Разделение осознанное: `BidService` — только арифметика и атомарность, он
 * ничего не знает про людей и деньги на счетах. Здесь наоборот — кто именно
 * ставит и позволено ли ему это, но без единой строчки про цену.
 *
 * Порядок: сначала дешёвые проверки в PostgreSQL, потом атомарное ядро. Обратный
 * порядок означал бы принятую ставку от неверифицированного участника, которую
 * пришлось бы откатывать — а откатить принятую ставку в аукционе нельзя, она
 * уже разослана всем и сдвинула цену.
 */
@Injectable()
export class BidPlacementService {
  private readonly logger = new Logger(BidPlacementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bids: BidService,
    private readonly blindIds: BlindIdService,
    private readonly rateLimit: BidRateLimitService,
  ) {}

  /**
   * Поставить от имени участника.
   *
   * Псевдоним не принимается снаружи, а выдаётся здесь (T-029): позволь его
   * прислать — и участник назовётся чужим номером, а лента ставок перестанет
   * быть доказательством чего бы то ни было.
   */
  async place(input: {
    lotId: string;
    userId: string;
    expectedAmountTiyn: bigint;
    /** Сессия входа и адрес — по ним считается частота (FR-10). */
    sessionId?: string;
    ip?: string | null;
  }): Promise<PlacementResult> {
    /**
     * Лимит частоты стоит первым — до похода в базу за правами.
     *
     * Смысл лимита в том, чтобы автокликер не занимал систему; проверяй мы
     * сначала верификацию и задаток, каждая отбитая попытка всё равно стоила
     * бы двух запросов в PostgreSQL, и защита работала бы на нас, а не на них.
     */
    if (input.sessionId !== undefined) {
      const rate = await this.rateLimit.hit({
        sessionId: input.sessionId,
        ip: input.ip ?? null,
      });
      if (!rate.allowed) {
        return { status: 'REJECTED', code: 'RATE_LIMITED', retryAfterMs: rate.retryAfterMs };
      }
    }

    const denied = await this.checkEligibility(input.userId, input.lotId);
    if (denied !== null) {
      // Отказ по праву — не инцидент, а штатная ветка: логируем спокойно, но
      // логируем, потому что всплеск таких отказов означает либо сломанный
      // клиент, либо перебор чужих лотов (T-049).
      this.logger.debug(`Лот ${input.lotId}: ставка отклонена — ${denied}`);
      return { status: 'REJECTED', code: denied };
    }

    const code = await this.blindIds.codeFor(input.lotId, input.userId);
    const outcome: BidOutcome = await this.bids.place({
      lotId: input.lotId,
      bidderId: input.userId,
      blindCode: BlindIdService.label(code),
      expectedAmountTiyn: input.expectedAmountTiyn,
    });

    if (outcome.status === 'REJECTED') {
      return { status: 'REJECTED', code: outcome.code };
    }
    return {
      status: 'ACCEPTED',
      seq: outcome.seq,
      priceTenge: Number(outcome.priceTiyn / 100n),
    };
  }

  /**
   * Имеет ли участник право ставить на этот лот. `null` — имеет.
   *
   * Всё одним запросом на пользователя и одним на задаток: путь ставки —
   * критический, и лишний поход в базу здесь стоит миллисекунд на каждой
   * ставке при пятидесяти тысячах участников.
   */
  async checkEligibility(userId: string, lotId: string): Promise<BidDenyCode | null> {
    const [user, lot] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.lot.findUnique({ where: { id: lotId }, select: { sellerId: true } }),
    ]);

    if (user === null || user.status === 'BLOCKED') {
      return 'USER_BLOCKED';
    }
    // Верификация — условие допуска к деньгам (FR-03). Читается из БД, а не из
    // токена: снятая верификация обязана действовать немедленно.
    if (user.egovVerifiedAt === null) {
      return 'EGOV_NOT_VERIFIED';
    }
    if (lot !== null && lot.sellerId === userId) {
      // Продавец, разгоняющий цену собственного лота, — это подлог, а не
      // участие. Проверка здесь, а не только в интерфейсе (см. DoD T-041).
      return 'SELLER_OWN_LOT';
    }

    const deposit = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId, lotId } },
      select: { status: true },
    });
    if (deposit?.status !== 'ON_SPECIAL_ACCOUNT') {
      // Без задатка на спецсчёте ставка не принимается ни при каких условиях:
      // иначе цену поднимает тот, кто не может заплатить.
      return 'NO_DEPOSIT';
    }

    return null;
  }
}
