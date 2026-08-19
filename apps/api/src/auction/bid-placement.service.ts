import type { BehaviorSignals, BidDenyCode, BidRejectCode } from '@auction/shared';
import { Injectable, Logger } from '@nestjs/common';

import { AntibotService } from '../antibot/antibot.service';
import { BIDDING_ALLOWED_FROM } from '../deposits/deposit-status.machine';
import { MetricsService, secondsSince } from '../metrics/metrics.service';
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
      /**
       * Актуальное состояние торгов на момент отказа, суммы в целых тенге.
       *
       * Есть у отказов ядра — там цена известна тому же скрипту, что отказал.
       * У отказов по праву (нет задатка, не верифицирован) отсутствует: цена от
       * них не менялась, а лишний поход в Redis на каждой такой попытке —
       * плата за информацию, которая участнику ничего не меняет.
       */
      readonly live?: {
        readonly currentPriceTenge: number;
        readonly nextPriceTenge: number;
        readonly seq: number;
      };
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
    private readonly bidAudit: BidAuditService,
    private readonly antibot: AntibotService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Поставить от имени участника — и замерить, сколько это заняло.
   *
   * Замер обёрткой, а не строчками внутри: у пути ставки шесть выходов (частота,
   * капча, права, три кода ядра), и отметить их по одному значит однажды
   * забыть — как раз тот выход, который окажется медленным. Приёмка сверяет с
   * ≤15 мс именно эту величину (NFR-02, ОВ-2).
   */
  async place(input: {
    lotId: string;
    userId: string;
    expectedAmountTiyn: bigint;
    sessionId?: string;
    ip?: string | null;
    behavior?: BehaviorSignals | null;
  }): Promise<PlacementResult> {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await this.run(input);
      this.metrics.observeBid({
        seconds: secondsSince(startedAt),
        outcome: result.status === 'ACCEPTED' ? 'accepted' : 'rejected',
        // Метка code пустая у принятых: серии с разным набором меток пришлось бы
        // складывать вручную в каждом запросе.
        code: result.status === 'ACCEPTED' ? '' : result.code,
      });
      return result;
    } catch (error) {
      this.metrics.observeBid({ seconds: secondsSince(startedAt), outcome: 'error', code: '' });
      throw error;
    }
  }

  /**
   * Поставить от имени участника.
   *
   * Псевдоним не принимается снаружи, а выдаётся здесь (T-029): позволь его
   * прислать — и участник назовётся чужим номером, а лента ставок перестанет
   * быть доказательством чего бы то ни было.
   */
  private async run(input: {
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

    // Ядро замеряется отдельно от полного пути: нагрузочный прогон T-051
    // показал, что основной вклад дают обращения в PostgreSQL ДО него. С одной
    // метрикой видно только «медленно», но не что оптимизировать.
    const coreStartedAt = process.hrtime.bigint();
    const outcome: BidOutcome = await this.bids.place({
      lotId: input.lotId,
      bidderId: input.userId,
      blindCode: BlindIdService.label(code),
      expectedAmountTiyn: input.expectedAmountTiyn,
    });
    this.metrics.observeBidCore(secondsSince(coreStartedAt));

    if (outcome.status === 'REJECTED') {
      // Сумму, которую сервер ждал, приносит сам отказ. Отдельным запросом её
      // читать нельзя: отказ в гонке — это 99 путей из 100, и лишний round-trip
      // на каждом означал бы, что чем острее борьба за лот, тем медленнее
      // система (T-052). Без неё же по отказу непонятно, насколько участник
      // промахнулся (QA-04).
      this.audit(input, outcome.code, outcome.live?.nextPriceTiyn ?? null);
      return {
        status: 'REJECTED',
        code: outcome.code,
        ...(outcome.live === undefined
          ? {}
          : {
              live: {
                currentPriceTenge: Number(outcome.live.priceTiyn / 100n),
                nextPriceTenge: Number(outcome.live.nextPriceTiyn / 100n),
                seq: outcome.live.seq,
              },
            }),
      };
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
   * ОДИН запрос в PostgreSQL на все три вопроса: кто ставит, чей это лот и есть
   * ли задаток. Раньше их было три — пользователь и лот параллельно, задаток
   * следом, — и приёмочный прогон T-055 показал цену этого: ядро ставки
   * укладывается в 2.4 мс при пороге 15, а полный путь — в 47.7 мс, и разница
   * почти целиком складывается из ожидания базы. Ожидание не постоянно: под
   * нагрузкой каждое обращение стоит очереди к пулу, и три обращения дают три
   * очереди.
   *
   * Соединением, а не кэшем: у кэша допуска пришлось бы выбирать время жизни,
   * а любое ненулевое означает окно, в котором ставку принимают у того, чей
   * задаток уже вернули. Здесь же данные ровно такие же свежие, как раньше.
   */
  async checkEligibility(userId: string, lotId: string): Promise<BidDenyCode | null> {
    const rows = await this.prisma.$queryRaw<EligibilityRow[]>`
      SELECT
        u.status::text                 AS user_status,
        u.egov_verified_at             AS egov_verified_at,
        l.seller_id::text              AS seller_id,
        d.status::text                 AS deposit_status
      FROM users u
      LEFT JOIN lots l ON l.id = ${lotId}::uuid
      LEFT JOIN deposits d ON d.user_id = u.id AND d.lot_id = ${lotId}::uuid
      WHERE u.id = ${userId}::uuid
    `;
    const row = rows[0];

    if (row === undefined || row.user_status === 'BLOCKED') {
      return 'USER_BLOCKED';
    }
    // Верификация — условие допуска к деньгам (FR-03). Читается из БД, а не из
    // токена: снятая верификация обязана действовать немедленно.
    if (row.egov_verified_at === null) {
      return 'EGOV_NOT_VERIFIED';
    }
    if (row.seller_id === userId) {
      // Продавец, разгоняющий цену собственного лота, — это подлог, а не
      // участие. Проверка здесь, а не только в интерфейсе (см. DoD T-041).
      return 'SELLER_OWN_LOT';
    }

    // Без задатка на спецсчёте ставка не принимается ни при каких условиях:
    // иначе цену поднимает тот, кто не может заплатить. С каким именно статусом
    // ставить можно, решает статусная машина задатка (T-034) — здесь только
    // сверка с её ответом, а не своя копия правила.
    if (row.deposit_status !== BIDDING_ALLOWED_FROM) {
      return 'NO_DEPOSIT';
    }

    return null;
  }
}

/** Строка ответа на единственный запрос допуска. Имена — как в SQL. */
interface EligibilityRow {
  readonly user_status: string | null;
  readonly egov_verified_at: Date | null;
  readonly seller_id: string | null;
  readonly deposit_status: string | null;
}
