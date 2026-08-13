import { SMART_HAMMER_TIMER_MS, type SessionStatusValue } from '@auction/shared';
import { Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import type { RedisScript } from '../redis/redis-script';

import { NEXT_PRICE_LUA, NOW_MS_LUA } from './lua/primitives';

/**
 * Сколько живёт ключ состояния торгов.
 *
 * Это страховка от утечки ключей, а не механизм завершения: авторитет по
 * завершению — finisher (T-027), TTL взят с огромным запасом, чтобы не убить
 * замороженные по SLA торги (FR-08). Каждая принятая ставка продлевает его
 * заново вместе со сбросом дедлайна.
 */
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Создать состояние торгов. Возвращает ошибку, если состояние уже есть:
 * второй старт по тому же лоту обнулил бы цену идущих торгов.
 *
 * KEYS[1] — ключ состояния
 * ARGV[1] — id сессии, ARGV[2] — стартовая цена в тиынах,
 * ARGV[3] — таймер в мс, ARGV[4] — TTL ключа в мс
 */
const START_SESSION = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.error_reply('SESSION_ALREADY_RUNNING')
end
${NOW_MS_LUA}
local deadlineMs = nowMs + tonumber(ARGV[3])
redis.call('HSET', KEYS[1],
  'sessionId', ARGV[1],
  'status', 'RUNNING',
  'priceTiyn', ARGV[2],
  'seq', '0',
  'deadlineMs', string.format('%.0f', deadlineMs))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return { string.format('%.0f', nowMs), string.format('%.0f', deadlineMs) }
`;

/**
 * Прочитать состояние вместе с текущим временем Redis и суммой следующего шага.
 *
 * Одним скриптом, а не тремя командами. Остаток таймера — это разность дедлайна
 * и «сейчас»: возьми их по отдельности, и между ними успеет пройти время. На
 * пятидесяти секундах это незаметно, на разборе спорной ставки — уже нет.
 *
 * Сумма шага считается здесь же тем же кодом, что и при приёме ставки. Иначе
 * её пришлось бы считать клиенту, появилась бы вторая реализация округления —
 * и участник, честно приславший «свою» сумму, ловил бы PRICE_MISMATCH.
 *
 * KEYS[1] — ключ состояния
 */
const READ_STATE = `
${NEXT_PRICE_LUA}
local state = redis.call('HGETALL', KEYS[1])
if #state == 0 then
  return nil
end
${NOW_MS_LUA}
table.insert(state, 'nowMs')
table.insert(state, string.format('%.0f', nowMs))
table.insert(state, 'nextPriceTiyn')
table.insert(state, string.format('%.0f', nextPriceTiyn(tonumber(redis.call('HGET', KEYS[1], 'priceTiyn')))))
return state
`;

/**
 * Остатки таймера сразу по многим лотам, одним снимком часов.
 *
 * Тикер вещает раз в секунду в каждую комнату, и походом за каждым лотом
 * отдельно gateway превратился бы в генератор запросов: сотня активных лотов —
 * сотня round-trip'ов ежесекундно на каждом инстансе. Здесь один вызов и одно
 * «сейчас» на всех: значения гарантированно сняты одним и тем же часами.
 *
 * KEYS — ключи состояний. Ответ: [nowMs, (lotKey, status, deadlineMs, seq)…],
 * лоты без состояния в ответ не попадают.
 */
const READ_TIMERS = `
${NOW_MS_LUA}
local out = { string.format('%.0f', nowMs) }
for i = 1, #KEYS do
  local s = redis.call('HMGET', KEYS[i], 'status', 'deadlineMs', 'seq')
  if s[1] then
    out[#out + 1] = KEYS[i]
    out[#out + 1] = s[1]
    out[#out + 1] = s[2]
    out[#out + 1] = s[3]
  end
end
return out
`;

/** Восстановить состояние из PostgreSQL, если ключ потерян. Не трогает существующий. */
const RESTORE_STATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'sessionId', ARGV[1],
  'status', ARGV[2],
  'priceTiyn', ARGV[3],
  'seq', ARGV[4],
  'deadlineMs', ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]))
return 1
`;

/** Состояние торгов так, как его видит сервер. Деньги — в тиынах. */
export interface AuctionState {
  readonly sessionId: string;
  readonly status: SessionStatusValue;
  readonly priceTiyn: bigint;
  /** Сумма следующей ставки. Считает Redis тем же кодом, что и приём ставки. */
  readonly nextPriceTiyn: bigint;
  readonly seq: number;
  /** Момент закрытия торгов по часам Redis, мс эпохи. */
  readonly deadlineMs: number;
  /** «Сейчас» по тем же часам — снято одновременно с остальным. */
  readonly nowMs: number;
}

/**
 * Остаток таймера одного лота. Урезанный срез состояния: тикеру не нужны ни
 * цена, ни id сессии, а гонять их раз в секунду по всем комнатам — лишний
 * трафик на пустом месте.
 */
export interface AuctionTimer {
  readonly lotId: string;
  readonly status: SessionStatusValue;
  readonly seq: number;
  /** Уже посчитан на часах Redis и никогда не отрицателен. */
  readonly timeRemainingMs: number;
  readonly nowMs: number;
}

/**
 * Состояние торгов в Redis (T-022).
 *
 * Redis здесь авторитет: цена, дедлайн, seq и статус во время сессии живут
 * тут, а PostgreSQL хранит деньги и аудит (CLAUDE.md §4.3). Любая операция,
 * меняющая состояние, — атомарный Lua-скрипт: между чтением цены и её
 * изменением не должно быть зазора, в который влезет вторая ставка.
 */
@Injectable()
export class AuctionStateService {
  private readonly startScript: RedisScript;
  private readonly readScript: RedisScript;
  private readonly timersScript: RedisScript;
  private readonly restoreScript: RedisScript;

  constructor(private readonly redis: RedisService) {
    this.startScript = redis.script(START_SESSION);
    this.readScript = redis.script(READ_STATE);
    this.timersScript = redis.script(READ_TIMERS);
    this.restoreScript = redis.script(RESTORE_STATE);
  }

  /** Ключ состояния лота. Публичный: на него подписывается gateway (T-023). */
  stateKey(lotId: string): string {
    return this.redis.key('session', lotId);
  }

  /**
   * Завести состояние новых торгов. Дедлайн считает сам Redis — так он
   * привязан к тем же часам, с которыми его потом сравнивает скрипт ставки.
   */
  async start(input: {
    lotId: string;
    sessionId: string;
    priceTiyn: bigint;
  }): Promise<{ startedAtMs: number; deadlineMs: number }> {
    const raw = await this.startScript.run(
      [this.stateKey(input.lotId)],
      [input.sessionId, input.priceTiyn.toString(), SMART_HAMMER_TIMER_MS, STATE_TTL_MS],
    );

    const pair = asStringArray(raw);
    const startedAtMs = Number(pair[0]);
    const deadlineMs = Number(pair[1]);
    if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(deadlineMs)) {
      throw new Error(`Redis вернул некорректное время старта сессии: ${JSON.stringify(raw)}`);
    }
    return { startedAtMs, deadlineMs };
  }

  /** Текущее состояние торгов или null, если сессия не поднята. */
  async read(lotId: string): Promise<AuctionState | null> {
    const raw = await this.readScript.run([this.stateKey(lotId)], []);
    if (raw === null) {
      return null;
    }
    return parseState(asStringArray(raw));
  }

  /**
   * Поднять состояние из PostgreSQL, если ключ потерялся.
   *
   * Нужно не для красоты: перезапуск Redis посреди торгов иначе означал бы,
   * что лот в PHASE_III существует, а ставку принять невозможно. Возвращает
   * false, если состояние уже было — восстановление не затирает живое.
   */
  async restore(input: {
    lotId: string;
    sessionId: string;
    status: SessionStatusValue;
    priceTiyn: bigint;
    seq: number;
    deadlineMs: number;
  }): Promise<boolean> {
    const written = await this.restoreScript.run(
      [this.stateKey(input.lotId)],
      [
        input.sessionId,
        input.status,
        input.priceTiyn.toString(),
        input.seq,
        input.deadlineMs,
        STATE_TTL_MS,
      ],
    );
    return written === 1;
  }

  /**
   * Остатки таймера по списку лотов. Лоты без торгов в ответе отсутствуют.
   *
   * Остаток считается здесь, а не у вызывающего: «сейчас» и дедлайн обязаны
   * быть с одних часов, иначе на разных инстансах gateway участники увидят
   * разное время до закрытия одного и того же лота (NFR-04).
   */
  async readTimers(lotIds: readonly string[]): Promise<AuctionTimer[]> {
    if (lotIds.length === 0) {
      return [];
    }

    const raw = await this.timersScript.run(
      lotIds.map((lotId) => this.stateKey(lotId)),
      [],
    );
    const flat = asStringArray(raw);
    const nowMs = Number(flat[0]);
    const timers: AuctionTimer[] = [];

    for (let i = 1; i + 3 < flat.length + 1; i += 4) {
      const key = flat[i];
      const status = flat[i + 1];
      if (key === undefined || status === undefined) {
        break;
      }
      if (status !== 'RUNNING' && status !== 'FROZEN' && status !== 'FINISHED') {
        continue;
      }
      const deadlineMs = Number(flat[i + 2] ?? '0');
      timers.push({
        lotId: key.slice(key.lastIndexOf(':') + 1),
        status,
        seq: Number(flat[i + 3] ?? '0'),
        // Отрицательного остатка не бывает: «минус три секунды» на экране
        // означали бы, что торги идут после закрытия.
        timeRemainingMs: Math.max(0, deadlineMs - nowMs),
        nowMs,
      });
    }
    return timers;
  }

  /** Снять состояние. Нужен закрытию торгов и уборке в тестах. */
  async drop(lotId: string): Promise<void> {
    await this.redis.client.del(this.stateKey(lotId));
  }
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Ожидался массив от Redis, получено: ${JSON.stringify(raw)}`);
  }
  return (raw as readonly unknown[]).map((item) => String(item));
}

function parseState(flat: readonly string[]): AuctionState {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    map.set(flat[i] ?? '', flat[i + 1] ?? '');
  }

  const status = map.get('status');
  if (status !== 'RUNNING' && status !== 'FROZEN' && status !== 'FINISHED') {
    throw new Error(`Неизвестный статус сессии в Redis: ${String(status)}`);
  }

  return {
    sessionId: map.get('sessionId') ?? '',
    status,
    priceTiyn: BigInt(map.get('priceTiyn') ?? '0'),
    nextPriceTiyn: BigInt(map.get('nextPriceTiyn') ?? '0'),
    seq: Number(map.get('seq') ?? '0'),
    deadlineMs: Number(map.get('deadlineMs') ?? '0'),
    nowMs: Number(map.get('nowMs') ?? '0'),
  };
}
