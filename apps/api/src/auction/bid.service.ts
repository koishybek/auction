import { BID_RACE_CODES, SMART_HAMMER_TIMER_MS, type BidRaceCode } from '@auction/shared';
import { Injectable, NotFoundException } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import type { RedisScript } from '../redis/redis-script';

import { AuctionStateService, STATE_TTL_MS } from './auction-state.service';
import { NEXT_PRICE_LUA, NOW_MS_LUA } from './lua/primitives';

export type BidOutcome =
  | {
      readonly status: 'ACCEPTED';
      readonly seq: number;
      readonly priceTiyn: bigint;
      readonly deadlineMs: number;
      readonly serverTs: number;
    }
  | { readonly status: 'REJECTED'; readonly code: BidRaceCode };

/** Следующая цена по правилам шага. nil, если торгов нет. */
const NEXT_PRICE = `
${NEXT_PRICE_LUA}
local price = redis.call('HGET', KEYS[1], 'priceTiyn')
if not price then
  return nil
end
return string.format('%.0f', nextPriceTiyn(tonumber(price)))
`;

/**
 * Ядро ставки. Всё или ничего.
 *
 * Проверка дедлайна, сверка суммы, новая цена, следующий seq, сброс таймера и
 * оповещение — один скрипт. Redis выполняет скрипты по одному, поэтому между
 * «прочитали цену» и «записали новую» не существует момента, в который влезет
 * вторая ставка. Это и есть ответ на главный риск проекта: две принятые ставки
 * на один шаг — юридический спор о деньгах, а не расхождение счётчика.
 *
 * Порядок проверок — от самого дешёвого и самого частого отказа к редкому.
 *
 * KEYS[1] — состояние, KEYS[2] — индекс дедлайнов, KEYS[3] — outbox ставок
 * ARGV[1] — присланная участником сумма в тиынах
 * ARGV[2] — id участника, ARGV[3] — псевдоним в лоте
 * ARGV[4] — таймер в мс, ARGV[5] — TTL ключа в мс
 * ARGV[6] — канал оповещения, ARGV[7] — id лота
 */
const PLACE_BID = `
${NEXT_PRICE_LUA}
local state = redis.call('HMGET', KEYS[1],
  'status', 'priceTiyn', 'seq', 'deadlineMs', 'sessionId', 'lastBidderId')
if not state[1] then
  return { 'NO_SESSION' }
end
if state[1] ~= 'RUNNING' then
  return { 'NOT_RUNNING' }
end
${NOW_MS_LUA}
if nowMs >= tonumber(state[4]) then
  return { 'TIMER_EXPIRED' }
end

-- Перебивать собственную последнюю ставку запрещено (ТЗ, self-outbid).
--
-- Проверка стоит ЗДЕСЬ, а не до вызова скрипта, как предлагает план: снаружи
-- она читает состояние отдельным запросом, и между чтением и записью
-- участник успевает стать последним. Тогда запрет обходится двойным кликом —
-- а это накрутка цены на собственном лоте. Внутри скрипта окна не существует.
--
-- Раньше сверки суммы намеренно: «вы и так лидируете» полезнее для человека,
-- чем «цена изменилась», хотя формально верно и то и другое.
if state[6] == ARGV[2] then
  return { 'SELF_OUTBID' }
end

local nextTiyn = nextPriceTiyn(tonumber(state[2]))
if tonumber(ARGV[1]) ~= nextTiyn then
  return { 'PRICE_MISMATCH' }
end

local seq = tonumber(state[3]) + 1
local newDeadlineMs = nowMs + tonumber(ARGV[4])

redis.call('HSET', KEYS[1],
  'priceTiyn', string.format('%.0f', nextTiyn),
  'seq', tostring(seq),
  'deadlineMs', string.format('%.0f', newDeadlineMs),
  'lastBidderId', ARGV[2],
  'lastBlindCode', ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
-- Дедлайн двигается и в индексе finisher'а — тем же атомарным шагом.
-- Разъедься они, finisher закрыл бы торги, в которых только что была ставка.
redis.call('ZADD', KEYS[2], newDeadlineMs, ARGV[7])

-- Outbox: принятая ставка попадает в поток тем же скриптом, что её приняла.
-- Отдельной записью «после» она бы терялась при падении процесса между
-- принятием и записью — и в PostgreSQL не осталось бы следа от ставки,
-- которая уже сдвинула цену и разослана всем участникам (CLAUDE.md §4.3).
redis.call('XADD', KEYS[3], 'MAXLEN', '~', '100000', '*',
  'lotId', ARGV[7],
  'sessionId', state[5],
  'userId', ARGV[2],
  'amountTiyn', string.format('%.0f', nextTiyn),
  'seq', tostring(seq),
  'blindCode', ARGV[3],
  'serverTs', string.format('%.0f', nowMs))

-- Событие ровно той структуры, что задана ТЗ §2.1: ключ 'event', суммы в
-- ТЕНГЕ, bid_step_kzt — величина шага, а не новая цена. Пересылать его
-- клиентам можно как есть, не разбирая: на 50 000 подключений разбор и
-- обратная сборка JSON в gateway — это работа на пустом месте.
redis.call('PUBLISH', ARGV[6], cjson.encode({
  event = 'bid_updated',
  lot_id = ARGV[7],
  current_price_kzt = nextTiyn / 100,
  bid_step_kzt = (nextTiyn - tonumber(state[2])) / 100,
  last_bidder_blind_id = ARGV[3],
  time_remaining_ms = tonumber(ARGV[4]),
  timestamp = nowMs,
  -- Сверх схемы ТЗ: номер ставки нужен клиенту после переподключения, чтобы
  -- отличить пропущенное от уже показанного (T-030). Лишние поля клиент,
  -- написанный по ТЗ, просто не читает.
  seq = seq,
  session_id = state[5]
}))

return {
  'ACCEPTED',
  string.format('%.0f', nextTiyn),
  tostring(seq),
  string.format('%.0f', newDeadlineMs),
  string.format('%.0f', nowMs)
}
`;

/**
 * Предел, за которым число Lua перестаёт быть точным целым (2^53 − 1).
 * Сумма выше этого до скрипта не доходит: там она превратилась бы в
 * приблизительную, и сравнение «равно ли шагу» стало бы лотереей.
 */
const MAX_EXACT_TIYN = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Приём ставки (T-024).
 *
 * Здесь только арифметика и атомарность. Кто имеет право ставить — верифицирован
 * ли он, внесён ли задаток, не перебивает ли сам себя — решает T-025 до вызова.
 * Персист ставки в PostgreSQL и лента истории — T-028.
 */
@Injectable()
export class BidService {
  private readonly nextPriceScript: RedisScript;
  private readonly placeScript: RedisScript;

  constructor(
    private readonly redis: RedisService,
    private readonly state: AuctionStateService,
  ) {
    this.nextPriceScript = redis.script(NEXT_PRICE);
    this.placeScript = redis.script(PLACE_BID);
  }

  /** Канал оповещений по лоту. Через него gateway разошлёт событие клиентам (T-023). */
  channel(lotId: string): string {
    return this.redis.key('channel', lotId);
  }

  /**
   * Поток принятых ставок, ожидающих записи в PostgreSQL (T-028).
   *
   * Один на всё приложение, а не на лот: у потребителя одна очередь и один
   * порядок, а лот всё равно есть в каждой записи.
   */
  outboxKey(): string {
    return this.redis.key('bids', 'outbox');
  }

  /**
   * Сумма следующей ставки.
   *
   * Считает Redis тем же кодом, что и приём ставки: если бы её считал клиент
   * или сервер на TypeScript, появилась бы вторая реализация правила
   * округления — и участник, честно приславший «свою» сумму, получал бы отказ.
   */
  async nextPriceTiyn(lotId: string): Promise<bigint> {
    const raw = await this.nextPriceScript.run([this.state.stateKey(lotId)], []);
    if (raw === null) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: 'По этому лоту торги не идут',
      });
    }
    // Сужаем, а не приводим: скрипт возвращает строку, и если однажды вернёт
    // не её, это должно быть видно сразу, а не превратиться в «NaN тиын».
    if (typeof raw !== 'string') {
      throw new Error(`Скрипт шага вернул не строку, а ${typeof raw}`);
    }
    return BigInt(raw);
  }

  /** Принять ставку или отказать. Изменение состояния целиком внутри Lua. */
  async place(input: {
    lotId: string;
    bidderId: string;
    blindCode: string;
    expectedAmountTiyn: bigint;
  }): Promise<BidOutcome> {
    if (input.expectedAmountTiyn < 0n || input.expectedAmountTiyn > MAX_EXACT_TIYN) {
      return { status: 'REJECTED', code: 'PRICE_MISMATCH' };
    }

    const raw = await this.placeScript.run(
      [this.state.stateKey(input.lotId), this.state.deadlinesKey(), this.outboxKey()],
      [
        input.expectedAmountTiyn.toString(),
        input.bidderId,
        input.blindCode,
        SMART_HAMMER_TIMER_MS,
        STATE_TTL_MS,
        this.channel(input.lotId),
        input.lotId,
      ],
    );

    return parseOutcome(raw);
  }
}

function parseOutcome(raw: unknown): BidOutcome {
  if (!Array.isArray(raw)) {
    throw new Error(`Скрипт ставки вернул не массив: ${JSON.stringify(raw)}`);
  }
  const parts = (raw as readonly unknown[]).map((item) => String(item));
  const code = parts[0];

  if (code === 'ACCEPTED') {
    return {
      status: 'ACCEPTED',
      priceTiyn: BigInt(parts[1] ?? '0'),
      seq: Number(parts[2] ?? '0'),
      deadlineMs: Number(parts[3] ?? '0'),
      serverTs: Number(parts[4] ?? '0'),
    };
  }
  if (isRaceCode(code)) {
    return { status: 'REJECTED', code };
  }
  throw new Error(`Скрипт ставки вернул неизвестный код: ${String(code)}`);
}

function isRaceCode(value: string | undefined): value is BidRaceCode {
  return BID_RACE_CODES.includes(value as BidRaceCode);
}
