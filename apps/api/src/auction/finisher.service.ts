import { Injectable, Logger } from '@nestjs/common';

import { DepositsService } from '../deposits/deposits.service';
import { RunnerUpService } from '../deposits/runner-up.service';
import { LotsService } from '../lots/lots.service';
import { RefBonusService } from '../partners/ref-bonus.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { RedisScript } from '../redis/redis-script';

import { AuctionStateService } from './auction-state.service';
import { BidService } from './bid.service';
import { NOW_MS_LUA } from './lua/primitives';

/**
 * Закрыть торги, если дедлайн прошёл. Всё или ничего.
 *
 * Это вторая половина гонки, первая — скрипт ставки. Redis выполняет скрипты по
 * одному, поэтому «ставка в последнюю миллисекунду» и «финиш» не могут
 * произойти оба: либо ставка успела и сдвинула дедлайн, и тогда здесь видно
 * STILL_RUNNING, либо финиш успел первым, и ставка получает NOT_RUNNING.
 * Двойного исхода не существует — а он означал бы двух победителей одного лота.
 *
 * KEYS[1] — состояние лота, KEYS[2] — индекс дедлайнов, KEYS[3] — набор
 * незафиксированных финишей
 * ARGV[1] — канал оповещения, ARGV[2] — id лота
 */
const FINISH_SESSION = `
local state = redis.call('HMGET', KEYS[1],
  'status', 'priceTiyn', 'seq', 'deadlineMs', 'sessionId', 'lastBidderId', 'lastBlindCode',
  'prevBidderId', 'prevBlindCode')
if not state[1] then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return { 'GONE' }
end
if state[1] ~= 'RUNNING' then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return { 'NOT_RUNNING' }
end
${NOW_MS_LUA}
local deadlineMs = tonumber(state[4])
if nowMs < deadlineMs then
  -- Ставка успела раньше и отодвинула дедлайн: торги живы.
  return { 'STILL_RUNNING', string.format('%.0f', deadlineMs - nowMs) }
end

redis.call('HSET', KEYS[1], 'status', 'FINISHED', 'finishedAtMs', string.format('%.0f', nowMs))
redis.call('ZREM', KEYS[2], ARGV[2])
-- Лот снят с индекса дедлайнов и больше сюда не вернётся, а запись в
-- PostgreSQL ещё не сделана. Отметка в этом наборе — единственное, по чему
-- незафиксированный финиш можно найти потом: без неё сбой базы оставляет лот
-- закрытым в Redis и «идущим» в базе навсегда (T-055).
redis.call('SADD', KEYS[3], ARGV[2])

-- Победитель — последний, чью ставку приняли. Если ставок не было вовсе,
-- лот закрывается без победителя: торги состоялись, покупателя нет.
local winner = state[7]
redis.call('PUBLISH', ARGV[1], cjson.encode({
  event = 'auction_finished',
  lot_id = ARGV[2],
  session_id = state[5],
  final_price_kzt = tonumber(state[2]) / 100,
  winner_blind_id = winner or cjson.null,
  seq = tonumber(state[3]),
  timestamp = nowMs
}))

return {
  'FINISHED',
  state[2],
  state[3],
  winner or '',
  state[6] or '',
  state[5],
  string.format('%.0f', nowMs),
  state[8] or '',
  state[9] or ''
}
`;

/** Чем закончилась попытка закрыть лот. */
export type FinishOutcome =
  | {
      readonly kind: 'FINISHED';
      readonly lotId: string;
      readonly sessionId: string;
      readonly finalPriceTiyn: bigint;
      readonly seq: number;
      readonly winnerBlindId: string | null;
      readonly winnerUserId: string | null;
      /** Участник №2 — ему по FR-14 достаётся выбор из двух опций. */
      readonly runnerUpUserId: string | null;
      readonly runnerUpBlindId: string | null;
      readonly finishedAtMs: number;
    }
  | { readonly kind: 'STILL_RUNNING'; readonly lotId: string; readonly remainingMs: number }
  | { readonly kind: 'ALREADY_CLOSED'; readonly lotId: string };

/**
 * Finisher — «дирижёр» лота (T-027).
 *
 * Ищет торги, у которых истёк дедлайн, и закрывает их. Работает в процессе
 * воркеров и переживает несколько реплик: закрыть лот дважды физически
 * невозможно, потому что решение принимает атомарный скрипт, а не проверка в
 * коде.
 *
 * Ключевое правило (CLAUDE.md §4.3): авторитет по завершению — этот код, а не
 * истечение TTL ключа. TTL стоит с запасом в сутки и служит только уборкой:
 * пауза сборщика мусора в Redis не должна решать, состоялись торги или нет.
 */
@Injectable()
export class FinisherService {
  private readonly logger = new Logger(FinisherService.name);
  private readonly finishScript: RedisScript;

  constructor(
    private readonly redis: RedisService,
    private readonly state: AuctionStateService,
    private readonly bids: BidService,
    private readonly prisma: PrismaService,
    private readonly lots: LotsService,
    private readonly deposits: DepositsService,
    private readonly runnerUp: RunnerUpService,
    private readonly refBonus: RefBonusService,
  ) {
    this.finishScript = redis.script(FINISH_SESSION);
  }

  /**
   * Закрыть все торги с истёкшим дедлайном. Возвращает закрытые.
   *
   * Сбой на одном лоте не отменяет разбор остальных: у каждого свой дедлайн и
   * свои участники, и падение записи по одному лоту не причина оставить
   * открытыми соседние. Незафиксированный лот подберёт `retryUnpersisted`.
   */
  async finishDue(nowMs: number): Promise<FinishOutcome[]> {
    const due = await this.state.dueLots(nowMs);
    const finished: FinishOutcome[] = [];

    for (const lotId of due) {
      try {
        const outcome = await this.finishLot(lotId);
        if (outcome.kind === 'FINISHED') {
          finished.push(outcome);
        }
      } catch (error) {
        this.logger.error(
          `Лот ${lotId}: закрытие не зафиксировано в базе — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return finished;
  }

  /**
   * Дозафиксировать финиши, которые не доехали в PostgreSQL.
   *
   * Нужна, потому что решение о закрытии принимает Redis и принимает его
   * необратимо: скрипт снимает лот с индекса дедлайнов, и второй раз он туда не
   * попадёт. Если запись в базу после этого упала, лот остаётся закрытым в
   * Redis и «идущим» в базе — а на строке сессии в базе висит всё остальное:
   * возвраты задатков ищут сессии со статусом FINISHED, протокол торгов тоже.
   * То есть проигравшие не получают свои 10 %, победитель не получает документ,
   * и никто об этом не узнаёт: в каталоге лот выглядит живым.
   *
   * Возвращает число дозафиксированных лотов.
   */
  async retryUnpersisted(limit = 50): Promise<number> {
    const pending = await this.redis.client.smembers(this.unpersistedKey());
    let fixed = 0;

    for (const lotId of pending.slice(0, limit)) {
      const outcome = await this.rebuildOutcome(lotId);
      if (outcome === null) {
        // Состояния в Redis больше нет — восстановить итог нечем. Молча
        // выбрасывать нельзя: это ставки, которые видели участники.
        this.logger.error(
          `Лот ${lotId}: финиш не зафиксирован, а состояние в Redis потеряно — разбирать руками`,
        );
        continue;
      }
      try {
        await this.persist(outcome);
        fixed += 1;
        this.logger.warn(`Лот ${lotId}: финиш дозафиксирован в базе повторным заходом`);
      } catch (error) {
        this.logger.error(
          `Лот ${lotId}: повторная фиксация финиша не удалась — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return fixed;
  }

  /** Сколько закрытых лотов ждут фиксации в базе. Ноль — норма. */
  async unpersistedCount(): Promise<number> {
    return await this.redis.client.scard(this.unpersistedKey());
  }

  /** Набор лотов, закрытых в Redis и ещё не зафиксированных в PostgreSQL. */
  unpersistedKey(): string {
    return this.redis.key('auction', 'finish', 'unpersisted');
  }

  /**
   * Собрать итог закрытых торгов заново из состояния в Redis.
   *
   * Тот же источник, из которого его собрал скрипт: цена, номер последней
   * ставки и псевдонимы двух последних участников живут в хеше состояния и
   * после закрытия не меняются.
   */
  private async rebuildOutcome(
    lotId: string,
  ): Promise<(FinishOutcome & { kind: 'FINISHED' }) | null> {
    const raw = await this.redis.client.hmget(
      this.state.stateKey(lotId),
      'status',
      'priceTiyn',
      'seq',
      'sessionId',
      'lastBidderId',
      'lastBlindCode',
      'prevBidderId',
      'prevBlindCode',
      'finishedAtMs',
    );
    const sessionId = raw[3] ?? '';
    if (raw[0] !== 'FINISHED' || sessionId === '') {
      return null;
    }
    // Пустая строка и отсутствие поля значат одно: такого участника не было.
    const text = (index: number): string | null => {
      const value = raw[index];
      return value === null || value === undefined || value === '' ? null : value;
    };
    return {
      kind: 'FINISHED',
      lotId,
      sessionId,
      finalPriceTiyn: BigInt(raw[1] ?? '0'),
      seq: Number(raw[2] ?? '0'),
      winnerUserId: text(4),
      winnerBlindId: text(5),
      runnerUpUserId: text(6),
      runnerUpBlindId: text(7),
      finishedAtMs: Number(raw[8] ?? '0'),
    };
  }

  /**
   * Попытаться закрыть один лот.
   *
   * Порядок: сначала Redis, потом PostgreSQL. Redis решает, кто победил, —
   * это единственное место, где решение принимается атомарно. PostgreSQL
   * фиксирует уже принятое решение: строку сессии, статус лота и итоговую
   * цену. Обратный порядок означал бы запись о завершении торгов, которые в
   * Redis всё ещё принимают ставки.
   */
  async finishLot(lotId: string): Promise<FinishOutcome> {
    const raw = await this.finishScript.run(
      [this.state.stateKey(lotId), this.state.deadlinesKey(), this.unpersistedKey()],
      [this.bids.channel(lotId), lotId],
    );
    const parts = asStrings(raw);

    if (parts[0] === 'STILL_RUNNING') {
      return { kind: 'STILL_RUNNING', lotId, remainingMs: Number(parts[1] ?? '0') };
    }
    if (parts[0] !== 'FINISHED') {
      return { kind: 'ALREADY_CLOSED', lotId };
    }

    const outcome: FinishOutcome = {
      kind: 'FINISHED',
      lotId,
      sessionId: parts[5] ?? '',
      finalPriceTiyn: BigInt(parts[1] ?? '0'),
      seq: Number(parts[2] ?? '0'),
      winnerBlindId: parts[3] === '' ? null : (parts[3] ?? null),
      winnerUserId: parts[4] === '' ? null : (parts[4] ?? null),
      runnerUpUserId: parts[7] === '' ? null : (parts[7] ?? null),
      runnerUpBlindId: parts[8] === '' ? null : (parts[8] ?? null),
      finishedAtMs: Number(parts[6] ?? '0'),
    };

    await this.persist(outcome);
    this.logger.log(
      `Лот ${lotId}: торги завершены на ${String(outcome.finalPriceTiyn / 100n)} ₸, ` +
        `ставок ${String(outcome.seq)}, победитель ${outcome.winnerBlindId ?? 'нет'}`,
    );
    return outcome;
  }

  /**
   * Зафиксировать итог в PostgreSQL.
   *
   * Идемпотентно: повторный вызов ничего не ломает. Это важно не ради красоты —
   * между записью в Redis и записью сюда процесс может умереть, и тогда лот
   * будет дозакрыт следующим проходом.
   *
   * `winnerBidId` здесь не проставляется: строк ставок в PostgreSQL пока нет,
   * их приносит T-028, он же и свяжет победителя со ставкой. Победитель при
   * этом не потерян — он в событии и в состоянии сессии.
   */
  private async persist(outcome: FinishOutcome & { kind: 'FINISHED' }): Promise<void> {
    await this.prisma.auctionSession.updateMany({
      where: { id: outcome.sessionId, status: { in: ['RUNNING', 'FROZEN'] } },
      data: { status: 'FINISHED', finishedAt: new Date(outcome.finishedAtMs) },
    });

    // Итоговая цена в лоте: каталог показывает её после закрытия.
    await this.prisma.lot.updateMany({
      where: { id: outcome.lotId },
      data: { currentPriceTiyn: outcome.finalPriceTiyn },
    });

    const lot = await this.prisma.lot.findUnique({ where: { id: outcome.lotId } });
    if (lot?.status === 'PHASE_III') {
      // Через ту же таблицу переходов, что и всё остальное: у finisher'а нет
      // привилегии менять статус в обход правил, и след остаётся в audit_log.
      await this.lots.transition({
        lotId: outcome.lotId,
        to: 'FINISHED',
        actor: 'SYSTEM',
        actorId: null,
      });
    }

    // Проигравшим пошёл отсчёт 24 часов на возврат (FR-12). Победитель здесь
    // известен точно — его определил тот же атомарный скрипт, что закрыл торги.
    // Само поручение в банк отправит воркер: finisher закрывает торги, деньги
    // двигают deposits/payments (CLAUDE.md, раздел 3).
    //
    // Сбой на этом шаге не отменяет завершения торгов и не должен ронять
    // разбор остальных лотов: в Redis лот уже закрыт, исключение отсюда
    // ничего не откатит, а только оставит соседей в очереди незакрытыми.
    // Оставшиеся задатки подберёт сверка возвратов.
    try {
      // Участнику №2 сначала предлагается выбор (FR-14) — его задаток в общий
      // возврат не идёт. Предложить нужно ДО открытия возвратов: иначе между
      // двумя шагами воркер успеет отправить поручение по его задатку.
      if (outcome.runnerUpUserId !== null) {
        await this.runnerUp.offer({
          lotId: outcome.lotId,
          userId: outcome.runnerUpUserId,
          finishedAtMs: outcome.finishedAtMs,
        });
      }
      await this.deposits.openRefundsForLot(outcome.lotId, {
        winnerUserId: outcome.winnerUserId,
        runnerUpUserId: outcome.runnerUpUserId,
      });

      // Доля партнёра перестала быть прогнозом: цена больше не изменится
      // (FR-19). Без победителя делить нечего — торги не состоялись.
      if (outcome.winnerUserId !== null) {
        await this.refBonus.accrue(outcome.lotId, outcome.finalPriceTiyn);
      }
    } catch (error) {
      this.logger.error(
        `Лот ${outcome.lotId}: возвраты не открыты — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Отметка снимается последней: пока она стоит, лот считается
    // незафиксированным и будет разобран повторно. Снять её раньше значило бы
    // объявить фиксацию удавшейся до того, как она удалась.
    await this.redis.client.srem(this.unpersistedKey(), outcome.lotId);
  }
}

function asStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Скрипт завершения вернул не массив: ${typeof raw}`);
  }
  return (raw as readonly unknown[]).map((item) => String(item));
}
