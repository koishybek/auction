import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { parseFieldCounters, type RedisScript } from '../redis/redis-script';
import { RedisService } from '../redis/redis.service';

/**
 * Окно антинакрутки: один посетитель на лот считается не чаще раза в час.
 * Час задан планом (T-017) и нужен, чтобы обновление страницы или возврат
 * из Data Room не превращались в новые «просмотры».
 */
const DEDUP_WINDOW_SEC = 3600;

/**
 * Домен псевдонима. Свой у каждой подсистемы: иначе один и тот же посетитель
 * получил бы одинаковый хеш здесь и, скажем, в антиботе, и две подсистемы
 * можно было бы связать по совпадению.
 */
const VIEWER_DOMAIN = 'lot_views.viewer';

/**
 * Отметить просмотр и, если он первый в окне, увеличить накопитель.
 *
 * Обе операции — одним скриптом: между «проверить, был ли» и «посчитать» не
 * должно быть зазора, иначе два одновременных захода одного посетителя
 * посчитаются дважды.
 *
 * KEYS[1] — ключ-отметка посетителя, KEYS[2] — хеш накопленных приростов
 * ARGV[1] — id лота (поле хеша), ARGV[2] — окно дедупликации в секундах
 */
const RECORD_VIEW = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[2]) then
  redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
  return 1
end
return 0
`;

/**
 * Забрать накопленное и обнулить одним шагом.
 *
 * Атомарность здесь не про производительность: реплик API несколько, таймер
 * сброса тикает в каждой. Без атомарного захвата две реплики прочитали бы одни
 * и те же приросты и прибавили их к лоту дважды.
 *
 * KEYS[1] — хеш накопленных приростов
 */
const CLAIM_PENDING = `
local pending = redis.call('HGETALL', KEYS[1])
if #pending > 0 then
  redis.call('DEL', KEYS[1])
end
return pending
`;

/** Чем идентифицируется посетитель. Ничего из этого не хранится в открытом виде. */
export interface ViewerIdentity {
  readonly userId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * Счётчик просмотров лота (T-017).
 *
 * Схема — «Redis считает, PostgreSQL хранит»: заходы в карточку идут потоком и
 * не стоят того, чтобы каждый раз трогать строку лота, но цифра нужна продавцу
 * долговременно, а Redis у нас не хранилище (CLAUDE.md §4.3).
 *
 * Продавец при этом всегда видит актуальное число: к сохранённому в БД
 * прибавляется ещё не сброшенный остаток. Сброс — вопрос нагрузки, не
 * корректности.
 */
@Injectable()
export class LotViewsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LotViewsService.name);
  private readonly recordScript: RedisScript;
  private readonly claimScript: RedisScript;
  private readonly pendingKey: string;
  private readonly flushIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly pii: PiiCryptoService,
    config: ConfigService<Env, true>,
  ) {
    this.recordScript = redis.script(RECORD_VIEW);
    this.claimScript = redis.script(CLAIM_PENDING);
    this.pendingKey = redis.key('lots', 'views', 'pending');
    this.flushIntervalMs = config.get('LOT_VIEWS_FLUSH_MS', { infer: true });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        this.logger.error(`Сброс просмотров не удался: ${describe(error)}`);
      });
    }, this.flushIntervalMs);

    // Счётчик просмотров не повод держать процесс живым: без unref
    // не завершились бы ни e2e, ни штатная остановка пода.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Засчитать просмотр. Возвращает false, если этот посетитель уже был
   * на лоте в течение часа.
   */
  async record(lotId: string, viewer: ViewerIdentity): Promise<boolean> {
    const viewerKey = this.viewerKey(viewer);
    const counted = await this.recordScript.run(
      [this.redis.key('lot', lotId, 'viewed', viewerKey), this.pendingKey],
      [lotId, DEDUP_WINDOW_SEC],
    );
    return counted === 1;
  }

  /**
   * Итоговое число просмотров для набора лотов: сохранённое в БД плюс ещё не
   * сброшенный остаток.
   */
  async withPending(
    lots: readonly { readonly id: string; readonly viewsCount: number }[],
  ): Promise<Map<string, number>> {
    const totals = new Map(lots.map((lot) => [lot.id, lot.viewsCount]));
    if (lots.length === 0) {
      return totals;
    }

    const raw = await this.redis.client.hmget(this.pendingKey, ...totals.keys());
    let index = 0;
    for (const [id, stored] of totals) {
      const pending = Number(raw[index] ?? 0);
      totals.set(id, stored + (Number.isSafeInteger(pending) ? pending : 0));
      index += 1;
    }
    return totals;
  }

  /**
   * Перенести накопленное из Redis в PostgreSQL. Возвращает число затронутых лотов.
   *
   * Явный UPDATE, а не Prisma-хелпер, ровно из-за `updated_at`: и `update`, и
   * `updateMany` в Prisma 7 проставляют `@updatedAt` сами, а просмотр карточки —
   * не изменение лота. Иначе продавец видел бы «изменён минуту назад» просто
   * оттого, что кто-то зашёл посмотреть. Проверено тестом на updated_at.
   */
  async flush(): Promise<number> {
    const deltas = parseFieldCounters(await this.claimScript.run([this.pendingKey], []));
    if (deltas.size === 0) {
      return 0;
    }

    let applied = 0;
    for (const [lotId, delta] of deltas) {
      try {
        const rows = await this.prisma.$executeRaw`
          UPDATE lots SET views_count = views_count + ${delta} WHERE id = ${lotId}::uuid
        `;
        if (rows > 0) {
          applied += 1;
        }
        // 0 строк — лота больше нет. Его просмотры никому не нужны, молча роняем.
      } catch (error) {
        // Прирост возвращается в очередь: потерять его из-за недоступной БД
        // хуже, чем сбросить на минуту позже.
        await this.redis.client.hincrby(this.pendingKey, lotId, delta).catch(() => undefined);
        this.logger.error(`Лот ${lotId}: просмотры возвращены в очередь — ${describe(error)}`);
      }
    }
    return applied;
  }

  /**
   * Кто смотрит. Авторизованный — это он сам; аноним узнаётся по IP и
   * User-Agent, но ни то ни другое не хранится: в Redis уходит только HMAC,
   * и тот живёт час.
   *
   * Слабое место известно и принято: за одним NAT (офис, мобильный оператор)
   * посетители с одинаковым браузером сольются в одного. Просмотры — мера
   * интереса, а не отчётность, и занижение здесь безопаснее накрутки.
   */
  private viewerKey(viewer: ViewerIdentity): string {
    if (viewer.userId !== null) {
      return `u:${viewer.userId}`;
    }
    const fingerprint = `${viewer.ip ?? 'нет-адреса'}|${viewer.userAgent ?? 'нет-агента'}`;
    return `a:${this.pii.pseudonym(fingerprint, VIEWER_DOMAIN)}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
