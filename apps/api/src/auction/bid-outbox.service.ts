import { Injectable, Logger } from '@nestjs/common';

import { MetricsService } from '../metrics/metrics.service';
import { isPermanentWriteError } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TimeService } from '../time/time.service';

import { BidService } from './bid.service';

/** Группа потребителей потока. Одна на всё приложение. */
const GROUP = 'persist';

/** Сколько записей забирается за один заход. */
const BATCH = 200;

/** Одна принятая ставка, снятая с потока. */
interface OutboxEntry {
  readonly id: string;
  readonly lotId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly amountTiyn: bigint;
  readonly seq: number;
  readonly blindCode: string;
  readonly serverTs: number;
}

/**
 * Перенос принятых ставок из Redis в PostgreSQL (T-028).
 *
 * Схема — outbox, как требует CLAUDE.md §4.3: ставку записывает в поток тот же
 * атомарный скрипт, который её принял, а сюда она попадает уже как факт.
 * Двойной записи «и туда, и туда» нет: если бы приложение писало в PostgreSQL
 * само, падение процесса между приёмом ставки и записью оставило бы сдвинутую
 * цену без юридического следа.
 *
 * Доставка «хотя бы один раз», и это осознанно: повтор безвреден, потеря — нет.
 * От повторов защищает сама база — уникальный ключ (session_id, seq). Она же
 * гарантирует, что двух ставок с одним номером в сессии не существует, даже
 * если что-то пробьётся мимо Lua-скрипта.
 *
 * Одна неисправимая запись НЕ останавливает перенос. Пачка пишется одним
 * `createMany`, и запись, которая не проходит по внешнему ключу, валит всю
 * пачку целиком: она повторяется бесконечно, а новые ставки не доезжают в
 * PostgreSQL вообще. Выглядит это как «лента пустая», и заметить это без
 * метрики нельзя. Поэтому упавшая пачка разбирается по одной, а запись, которая
 * не проходит и в одиночку, уходит в поток карантина: она не теряется, но и не
 * держит остальные. Карантин обязан быть виден — на него стоит алерт.
 */
@Injectable()
export class BidOutboxService {
  private readonly logger = new Logger(BidOutboxService.name);
  private groupReady = false;

  constructor(
    private readonly redis: RedisService,
    private readonly bids: BidService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly time: TimeService,
  ) {}

  /**
   * Перенести накопленное. Возвращает число записанных ставок.
   *
   * Сначала разбирается «зависшее» — записи, взятые прошлым заходом и не
   * подтверждённые: процесс мог умереть между чтением и записью. Только потом
   * берутся новые. Обратный порядок означал бы, что зависшая ставка не
   * запишется никогда.
   */
  async drain(limit = BATCH): Promise<number> {
    await this.ensureGroup();

    const pending = await this.read('0', limit);
    const fresh = pending.length < limit ? await this.read('>', limit - pending.length) : [];
    const entries = [...pending, ...fresh];
    if (entries.length === 0) {
      return 0;
    }

    // Подтверждение только после удавшейся записи: временная ошибка базы
    // бросается наружу из persist(), пачка остаётся неподтверждённой и придёт
    // следующим заходом. Подтвердить её здесь значило бы потерять ставки.
    const { written, quarantined } = await this.persist(entries);
    await this.redis.client.xack(this.bids.outboxKey(), GROUP, ...entries.map((e) => e.id));
    this.metrics.observeOutboxDrain({ written, quarantined });
    return written;
  }

  /** Сколько ставок ждёт переноса. Для метрик и проверок расхождения. */
  async pendingCount(): Promise<number> {
    await this.ensureGroup();
    const info = await this.redis.client.xpending(this.bids.outboxKey(), GROUP);
    return Array.isArray(info) ? Number(info[0] ?? 0) : 0;
  }

  /** Ключ потока карантина. Отдельный от рабочего: разбирает его человек. */
  deadKey(): string {
    return this.redis.key('bids', 'outbox', 'dead');
  }

  /** Сколько ставок лежит в карантине. Ноль — норма, всё прочее требует разбора. */
  async deadCount(): Promise<number> {
    return await this.redis.client.xlen(this.deadKey());
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) {
      return;
    }
    try {
      // MKSTREAM: поток может ещё не существовать — первая ставка создаст его.
      await this.redis.client.xgroup('CREATE', this.bids.outboxKey(), GROUP, '0', 'MKSTREAM');
    } catch (error) {
      // BUSYGROUP — группа уже есть, это норма при нескольких репликах.
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
    this.groupReady = true;
  }

  private async read(from: string, count: number): Promise<OutboxEntry[]> {
    if (count <= 0) {
      return [];
    }
    try {
      return parseEntries(await this.readGroup(from, count));
    } catch (error) {
      // NOGROUP — потока или группы больше нет: Redis перезапустили с чистого
      // листа, сработал FLUSHDB, переключились на реплику. Группа создаётся
      // заново, и разбор продолжается. Кэшировать «группа есть» навсегда
      // нельзя: один такой случай остановил бы перенос ставок молча.
      if (error instanceof Error && error.message.includes('NOGROUP')) {
        this.groupReady = false;
        await this.ensureGroup();
        return parseEntries(await this.readGroup(from, count));
      }
      throw error;
    }
  }

  private readGroup(from: string, count: number): Promise<unknown> {
    return this.redis.client.xreadgroup(
      'GROUP',
      GROUP,
      'persist-worker',
      'COUNT',
      count,
      'STREAMS',
      this.bids.outboxKey(),
      from,
    );
  }

  /**
   * Записать пачкой. `skipDuplicates` опирается на уникальный (session_id, seq):
   * повторно доставленная ставка молча отбрасывается, а не ломает перенос.
   *
   * Упавшая пачка не бросается наружу: одна плохая запись валит `createMany`
   * целиком, и повтор пачки даёт тот же результат вечно. Разбираем по одной —
   * хорошие ставки доезжают, плохая уходит в карантин.
   */
  private async persist(
    entries: readonly OutboxEntry[],
  ): Promise<{ written: number; quarantined: number }> {
    try {
      const result = await this.prisma.bid.createMany({
        data: entries.map((entry) => rowOf(entry)),
        skipDuplicates: true,
      });
      return { written: result.count, quarantined: 0 };
    } catch (error) {
      this.logger.warn(
        `Пачка из ${String(entries.length)} ставок не записалась целиком ` +
          `(${error instanceof Error ? error.message : String(error)}) — разбираю по одной`,
      );
      return await this.persistOneByOne(entries);
    }
  }

  /** По одной: виновата обычно одна запись, а не пачка. */
  private async persistOneByOne(
    entries: readonly OutboxEntry[],
  ): Promise<{ written: number; quarantined: number }> {
    let written = 0;
    let quarantined = 0;
    for (const entry of entries) {
      try {
        const result = await this.prisma.bid.createMany({
          data: [rowOf(entry)],
          skipDuplicates: true,
        });
        written += result.count;
      } catch (error) {
        /**
         * В карантин уходит только то, что не запишется никогда.
         *
         * Временный сбой базы — перезапуск, исчерпанный пул, моргнувшая сеть —
         * выглядит здесь точно так же, как битая запись, и разница огромна:
         * первую надо повторить, вторую повторять бессмысленно. Отправив в
         * карантин здоровую ставку, мы своими руками выкинули бы её из
         * юридической записи. Поэтому при временной ошибке бросаем наружу:
         * пачка не подтверждается и придёт следующим заходом целиком.
         */
        if (!isPermanentWriteError(error)) {
          throw error;
        }
        await this.quarantine(entry, error);
        quarantined += 1;
      }
    }
    return { written, quarantined };
  }

  /**
   * Убрать запись в карантин.
   *
   * Не удалить: ставку видели участники, и след обязан остаться — поток
   * карантина хранит её поля целиком плюс причину отказа базы. Дальше её
   * разбирает человек, а метрика `auction_bid_outbox_dead` не даёт про неё
   * забыть.
   */
  private async quarantine(entry: OutboxEntry, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.redis.client.xadd(
      this.deadKey(),
      '*',
      'lotId',
      entry.lotId,
      'sessionId',
      entry.sessionId,
      'userId',
      entry.userId,
      'amountTiyn',
      entry.amountTiyn.toString(),
      'seq',
      String(entry.seq),
      'blindCode',
      entry.blindCode,
      'serverTs',
      String(entry.serverTs),
      // Причина обрезается: сообщения Prisma содержат весь запрос целиком.
      'reason',
      reason.slice(0, 500),
      'quarantinedAt',
      String(this.time.wallClockMs()),
    );
    this.logger.error(
      `Ставка №${String(entry.seq)} лота ${entry.lotId} убрана в карантин: ${reason}`,
    );
  }
}

/** Строка таблицы `bids` из записи потока. */
function rowOf(entry: OutboxEntry): {
  lotId: string;
  sessionId: string;
  userId: string;
  amountTiyn: bigint;
  seq: number;
  blindCode: string;
  serverTs: Date;
} {
  return {
    lotId: entry.lotId,
    sessionId: entry.sessionId,
    userId: entry.userId,
    amountTiyn: entry.amountTiyn,
    seq: entry.seq,
    blindCode: entry.blindCode,
    serverTs: new Date(entry.serverTs),
  };
}

function parseEntries(raw: unknown): OutboxEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: OutboxEntry[] = [];
  for (const stream of raw as readonly unknown[]) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) {
      continue;
    }
    for (const item of stream[1] as readonly unknown[]) {
      if (!Array.isArray(item) || !Array.isArray(item[1])) {
        continue;
      }
      const fields = new Map<string, string>();
      const flat = item[1] as readonly unknown[];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        fields.set(String(flat[i]), String(flat[i + 1]));
      }
      entries.push({
        id: String(item[0]),
        lotId: fields.get('lotId') ?? '',
        sessionId: fields.get('sessionId') ?? '',
        userId: fields.get('userId') ?? '',
        amountTiyn: BigInt(fields.get('amountTiyn') ?? '0'),
        seq: Number(fields.get('seq') ?? '0'),
        blindCode: fields.get('blindCode') ?? '',
        serverTs: Number(fields.get('serverTs') ?? '0'),
      });
    }
  }
  return entries;
}
