import type { BehaviorSignals, BidDenyCode, BidRejectCode } from '@auction/shared';
import { Injectable, Logger } from '@nestjs/common';

import { AntibotService } from '../antibot/antibot.service';
import { DepositsService } from '../deposits/deposits.service';
import { PrismaService } from '../prisma/prisma.service';

import { BidAuditService } from './bid-audit.service';
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
    private readonly deposits: DepositsService,
    private readonly bidAudit: BidAuditService,
    private readonly antibot: AntibotService,
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
    /** Сигналы клика для поведенческой проверки (FR-11). */
    behavior?: BehaviorSignals | null;
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

      /**
       * Поведение клика (FR-11). После лимита частоты и до похода в базу:
       * проверка стоит одного запроса в Redis, а отсеивает автомат раньше,
       * чем тот займёт PostgreSQL.
       *
       * Санкция мягкая: не запрет, а требование доказать, что ты человек.
       */
      if (
        await this.antibot.shouldChallenge({
          sessionId: input.sessionId,
          lotId: input.lotId,
          signals: input.behavior ?? null,
        })
      ) {
        return { status: 'REJECTED', code: 'CAPTCHA_REQUIRED' };
      }
    }

    const denied = await this.checkEligibility(input.userId, input.lotId);
    if (denied !== null) {
      this.audit(input, denied, null);
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
      // Сумму, которую сервер ждал, читаем только здесь — на пути принятой
      // ставки этот запрос не нужен, а по отказу без неё непонятно, насколько
      // участник промахнулся (QA-04).
      const expected = await this.bids.nextPriceTiyn(input.lotId).catch(() => null);
      this.audit(input, outcome.code, expected);
      return { status: 'REJECTED', code: outcome.code };
    }
    return {
      status: 'ACCEPTED',
      seq: outcome.seq,
      priceTenge: Number(outcome.priceTiyn / 100n),
    };
  }

  /**
   * Записать отклонённую попытку в аудит (T-048, QA-04).
   *
   * Без `await`: участнику ответ уже готов, и ждать записи ему незачем. Отказы
   * по частоте не пишутся вовсе — автокликер даёт их сотнями, и запись каждого
   * превратила бы защиту от нагрузки в способ её создать.
   */
  private audit(
    input: {
      lotId: string;
      userId: string;
      expectedAmountTiyn: bigint;
      sessionId?: string;
      ip?: string | null;
    },
    code: BidRejectCode,
    serverAmountTiyn: bigint | null,
  ): void {
    if (!BidAuditService.isAudited(code)) {
      return;
    }
    this.bidAudit.record({
      lotId: input.lotId,
      userId: input.userId,
      code,
      sentAmountTiyn: input.expectedAmountTiyn,
      serverAmountTiyn,
      ip: input.ip ?? null,
      sessionId: input.sessionId ?? null,
    });
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

    // Без задатка на спецсчёте ставка не принимается ни при каких условиях:
    // иначе цену поднимает тот, кто не может заплатить. Условие живёт в
    // статусной машине задатка (T-034), а не сравнением строк здесь.
    if (!(await this.deposits.isAllowedToBid(userId, lotId))) {
      return 'NO_DEPOSIT';
    }

    return null;
  }
}
