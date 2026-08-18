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
 * KEYS[1] — ключ состояния, KEYS[2] — индекс дедлайнов
 * ARGV[1] — id сессии, ARGV[2] — стартовая цена в тиынах,
 * ARGV[3] — таймер в мс, ARGV[4] — TTL ключа в мс, ARGV[5] — id лота
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
redis.call('ZADD', KEYS[2], deadlineMs, ARGV[5])
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
  -- freezeRemainingMs читается вместе с остальным: во время паузы дедлайн
  -- намеренно не двигается, и остаток, посчитанный из него, продолжал бы
  -- убывать на экранах участников, пока торги стоят (T-054).
  local s = redis.call('HMGET', KEYS[i], 'status', 'deadlineMs', 'seq', 'freezeRemainingMs')
  if s[1] then
    out[#out + 1] = KEYS[i]
    out[#out + 1] = s[1]
    out[#out + 1] = s[2]
    out[#out + 1] = s[3]
    out[#out + 1] = s[4] or ''
  end
end
return out
`;

/**
 * Заморозить торги по SLA (T-032, FR-08).
 *
 * Снимок остатка снимается тем же скриптом, что меняет статус: возьми их
 * порознь — и между ними пройдёт время, которое участник потеряет безвозвратно.
 *
 * Лот убирается из индекса дедлайнов и попадает в индекс заморозок. Это не
 * бухгалтерия, а условие корректности: останься он в дедлайнах, finisher
 * закрыл бы замороженные торги как истёкшие ровно в тот момент, когда у
 * участников нет связи, чтобы возразить.
 *
 * KEYS[1] — состояние, KEYS[2] — индекс дедлайнов, KEYS[3] — индекс заморозок
 * ARGV[1] — длительность паузы в мс, ARGV[2] — канал, ARGV[3] — id лота
 */
const FREEZE_SESSION = `
local state = redis.call('HMGET', KEYS[1], 'status', 'deadlineMs', 'sessionId')
if not state[1] then
  return { 'NO_SESSION' }
end
if state[1] ~= 'RUNNING' then
  return { 'NOT_RUNNING' }
end
${NOW_MS_LUA}
local remainingMs = tonumber(state[2]) - nowMs
if remainingMs < 0 then
  remainingMs = 0
end
local resumeAtMs = nowMs + tonumber(ARGV[1])

redis.call('HSET', KEYS[1],
  'status', 'FROZEN',
  'freezeRemainingMs', string.format('%.0f', remainingMs),
  'resumeAtMs', string.format('%.0f', resumeAtMs))
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], resumeAtMs, ARGV[3])

redis.call('PUBLISH', ARGV[2], cjson.encode({
  event = 'sla_freeze',
  lot_id = ARGV[3],
  session_id = state[3],
  time_remaining_ms = remainingMs,
  resume_in_ms = tonumber(ARGV[1]),
  timestamp = nowMs
}))

return { 'FROZEN', string.format('%.0f', remainingMs), string.format('%.0f', resumeAtMs) }
`;

/**
 * Возобновить торги после паузы.
 *
 * Дедлайн собирается заново из снимка: участник получает ровно тот остаток,
 * что был у него в момент заморозки, а не «сколько осталось по календарю».
 *
 * KEYS[1] — состояние, KEYS[2] — индекс дедлайнов, KEYS[3] — индекс заморозок
 * ARGV[1] — канал, ARGV[2] — id лота
 */
const RESUME_SESSION = `
local state = redis.call('HMGET', KEYS[1], 'status', 'freezeRemainingMs', 'sessionId')
if state[1] ~= 'FROZEN' then
  redis.call('ZREM', KEYS[3], ARGV[2])
  return { 'NOT_FROZEN' }
end
${NOW_MS_LUA}
local remainingMs = tonumber(state[2])
local deadlineMs = nowMs + remainingMs

redis.call('HSET', KEYS[1], 'status', 'RUNNING', 'deadlineMs', string.format('%.0f', deadlineMs))
redis.call('HDEL', KEYS[1], 'freezeRemainingMs', 'resumeAtMs')
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('ZADD', KEYS[2], deadlineMs, ARGV[2])

redis.call('PUBLISH', ARGV[1], cjson.encode({
  event = 'sla_resume',
  lot_id = ARGV[2],
  session_id = state[3],
  time_remaining_ms = remainingMs,
  timestamp = nowMs
}))

return { 'RESUMED', string.format('%.0f', remainingMs), string.format('%.0f', deadlineMs) }
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
-- Индекс дедлайнов восстанавливается вместе с состоянием: иначе поднятые из
-- PostgreSQL торги стали бы невидимы для finisher'а и висели бы вечно.
if ARGV[2] == 'RUNNING' then
  redis.call('ZADD', KEYS[2], tonumber(ARGV[5]), ARGV[7])
end
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
  /**
   * Остаток, замороженный паузой SLA Freeze. `null` — паузы нет.
   *
   * Во время паузы `deadlineMs` НЕ двигается и продолжает уезжать в прошлое,
   * поэтому считать остаток из него нельзя: он утекал бы к нулю, пока торги
   * стоят. Участнику обещан ровно тот остаток, что был у него в момент
   * заморозки (ТЗ §2.2), и хранится он отдельным полем.
   */
  readonly freezeRemainingMs: number | null;
  /** Когда пауза кончится, мс эпохи по часам Redis. `null` — паузы нет. */
  readonly resumeAtMs: number | null;
  /**
   * Псевдоним последнего ставившего. В закрытых торгах это победитель.
   *
   * Хранится тем же атомарным скриптом, который принимает ставку, поэтому
   * доступен сразу и не ждёт, пока ставка доедет в PostgreSQL.
   */
  readonly lastBlindCode: string | null;
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
  private readonly freezeScript: RedisScript;
  private readonly resumeScript: RedisScript;

  constructor(private readonly redis: RedisService) {
    this.startScript = redis.script(START_SESSION);
    this.readScript = redis.script(READ_STATE);
    this.timersScript = redis.script(READ_TIMERS);
    this.restoreScript = redis.script(RESTORE_STATE);
    this.freezeScript = redis.script(FREEZE_SESSION);
    this.resumeScript = redis.script(RESUME_SESSION);
  }

  /** Ключ состояния лота. Публичный: на него подписывается gateway (T-023). */
  stateKey(lotId: string): string {
    return this.redis.key('session', lotId);
  }

  /**
   * Индекс дедлайнов: отсортированное множество «лот → момент закрытия».
   *
   * Нужен finisher'у (T-027), чтобы находить истёкшие торги за логарифм, а не
   * перебором ключей. SCAN по всем сессиям раз в секунду — это способ занять
   * Redis собой в тот самый момент, когда он обрабатывает ставки.
   */
  deadlinesKey(): string {
    return this.redis.key('deadlines');
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
      [this.stateKey(input.lotId), this.deadlinesKey()],
      [
        input.sessionId,
        input.priceTiyn.toString(),
        SMART_HAMMER_TIMER_MS,
        STATE_TTL_MS,
        input.lotId,
      ],
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
      [this.stateKey(input.lotId), this.deadlinesKey()],
      [
        input.sessionId,
        input.status,
        input.priceTiyn.toString(),
        input.seq,
        input.deadlineMs,
        STATE_TTL_MS,
        input.lotId,
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

    for (let i = 1; i + 4 <= flat.length; i += 5) {
      const key = flat[i];
      const status = flat[i + 1];
      if (key === undefined || status === undefined) {
        break;
      }
      if (status !== 'RUNNING' && status !== 'FROZEN' && status !== 'FINISHED') {
        continue;
      }
      const deadlineMs = Number(flat[i + 2] ?? '0');
      const frozenRemaining = optionalNumber(flat[i + 4]);

      /**
       * На паузе тик несёт замороженный остаток, а не посчитанный из дедлайна.
       *
       * Дедлайн при заморозке не двигается — по нему потом восстанавливается
       * ход торгов, — поэтому посчитанный из него остаток убывает и на
       * шестидесятой секунде паузы доходит до нуля. Участник видел бы, как
       * таймер досчитывает до «00.000» при живых торгах, и решил бы, что всё
       * кончилось: заморозку он видит баннером, а верит числу (найдено
       * disconnect-тестом T-054).
       *
       * Тик на паузе не отменяется, а исправляется: он ещё и признак жизни
       * соединения, и по его seq клиент замечает пропущенные ставки.
       */
      const timeRemainingMs =
        status === 'FROZEN' && frozenRemaining !== null
          ? Math.max(0, frozenRemaining)
          : // Отрицательного остатка не бывает: «минус три секунды» на экране
            // означали бы, что торги идут после закрытия.
            Math.max(0, deadlineMs - nowMs);

      timers.push({
        lotId: key.slice(key.lastIndexOf(':') + 1),
        status,
        seq: Number(flat[i + 3] ?? '0'),
        timeRemainingMs,
        nowMs,
      });
    }
    return timers;
  }

  /** Индекс замороженных торгов: лот → момент автоматического возобновления. */
  frozenKey(): string {
    return this.redis.key('frozen');
  }

  /**
   * Заморозить торги: статус FROZEN и снимок остатка одним шагом (T-032).
   * Возвращает null, если замораживать нечего — торги уже не идут.
   */
  async freeze(
    lotId: string,
    pauseMs: number,
    channel: string,
  ): Promise<{ remainingMs: number; resumeAtMs: number } | null> {
    const parts = asStringArray(
      await this.freezeScript.run(
        [this.stateKey(lotId), this.deadlinesKey(), this.frozenKey()],
        [pauseMs, channel, lotId],
      ),
    );
    if (parts[0] !== 'FROZEN') {
      return null;
    }
    return { remainingMs: Number(parts[1] ?? '0'), resumeAtMs: Number(parts[2] ?? '0') };
  }

  /** Возобновить торги, вернув остаток из снимка. null — лот не был заморожен. */
  async resume(
    lotId: string,
    channel: string,
  ): Promise<{ remainingMs: number; deadlineMs: number } | null> {
    const parts = asStringArray(
      await this.resumeScript.run(
        [this.stateKey(lotId), this.deadlinesKey(), this.frozenKey()],
        [channel, lotId],
      ),
    );
    if (parts[0] !== 'RESUMED') {
      return null;
    }
    return { remainingMs: Number(parts[1] ?? '0'), deadlineMs: Number(parts[2] ?? '0') };
  }

  /** Замороженные лоты, которым пора возобновиться. */
  async dueForResume(nowMs: number, limit = 100): Promise<string[]> {
    return this.redis.client.zrangebyscore(this.frozenKey(), '-inf', nowMs, 'LIMIT', 0, limit);
  }

  /** Лоты, чей дедлайн уже прошёл. Кандидаты на закрытие (T-027). */
  async dueLots(nowMs: number, limit = 100): Promise<string[]> {
    return this.redis.client.zrangebyscore(this.deadlinesKey(), '-inf', nowMs, 'LIMIT', 0, limit);
  }

  /** Снять состояние. Нужен закрытию торгов и уборке в тестах. */
  async drop(lotId: string): Promise<void> {
    await this.redis.client.del(this.stateKey(lotId));
    await this.redis.client.zrem(this.deadlinesKey(), lotId);
    await this.redis.client.zrem(this.frozenKey(), lotId);
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
    freezeRemainingMs: optionalNumber(map.get('freezeRemainingMs')),
    resumeAtMs: optionalNumber(map.get('resumeAtMs')),
    lastBlindCode: optionalText(map.get('lastBlindCode')),
  };
}

/**
 * Число из Redis или `null`, если поля нет.
 *
 * Именно `null`, а не ноль: ноль остатка означает «время вышло», и подставлять
 * его вместо «паузы нет» значило бы закрывать торги отсутствием поля.
 */
function optionalText(raw: string | undefined): string | null {
  return raw === undefined || raw === '' ? null : raw;
}

function optionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
