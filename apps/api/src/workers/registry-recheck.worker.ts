import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';

import type { Env } from '../config/env.schema';
import { RedisService } from '../redis/redis.service';
import { TimeService } from '../time/time.service';

import { RegistryRecheckService } from './registry-recheck.service';
import { JOB_CHECK_LOT, JOB_SWEEP, REGISTRY_QUEUE, SCHEDULER_DAILY } from './workers.constants';

/**
 * Сколько лотов проверяется одновременно. Упирается не в нас, а во внешний
 * реестр: КИСИП/ЕРД — государственная система, и обходить её лот за лотом в
 * сто потоков означает получить бан вместо ответов.
 */
const CONCURRENCY = 5;

/** Данные задачи на проверку конкретного лота. */
interface CheckLotData {
  readonly lotId: string;
}

/**
 * Данные задачи обхода. `bucket` — метка прогона, из неё собирается ключ
 * задачи на лот: два обхода с одной меткой не проверят лот дважды.
 */
interface SweepData {
  readonly bucket?: string;
}

/**
 * Крон перепроверки реестра (T-020).
 *
 * Устроен в два шага: расписание запускает обход, обход ставит по задаче на
 * каждый лот. Разница существенная. Одна задача «проверить всё» падает целиком
 * из-за одного неответившего запроса и ретраит уже проверенное; отдельная
 * задача на лот ретраится сама по себе, идёт с ограниченной параллельностью и
 * видна в очереди поимённо.
 */
@Injectable()
export class RegistryRecheckWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryRecheckWorker.name);
  private readonly intervalMs: number;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly recheck: RegistryRecheckService,
    private readonly time: TimeService,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('REGISTRY_RECHECK_INTERVAL_MS', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    // Свой префикс ключей: BullMQ по умолчанию занимает «bull:», общий для всех,
    // кто пишет в этот инстанс. Прогон e2e не должен видеть задачи разработки.
    const prefix = this.redis.key('bull');

    this.queue = new Queue(REGISTRY_QUEUE, {
      connection: this.redis.createQueueConnection('queue:registry'),
      prefix,
    });

    // upsert, а не add: расписание переживает перезапуск и правку интервала,
    // и несколько реплик воркера не заводят несколько кронов.
    await this.queue.upsertJobScheduler(
      SCHEDULER_DAILY,
      { every: this.intervalMs },
      { name: JOB_SWEEP },
    );

    this.worker = new Worker(REGISTRY_QUEUE, (job: Job) => this.process(job), {
      connection: this.redis.createQueueConnection('worker:registry'),
      prefix,
      concurrency: CONCURRENCY,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Задача ${job?.name ?? '?'} (${job?.id ?? '?'}): ${error.message}`);
    });

    this.logger.log(
      `Крон реестра поднят: обход раз в ${String(Math.round(this.intervalMs / 60_000))} мин`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    // Сначала воркер: он держит блокирующее соединение и активные задачи.
    await this.worker?.close();
    await this.queue?.close();
  }

  /**
   * Поставить обход немедленно, не дожидаясь расписания.
   *
   * `force` снимает суточную защиту от повтора. Без него обход, запущенный
   * вторым за те же сутки, лот не тронет — и это правильное поведение по
   * умолчанию: КИСИП/ЕРД государственная система, дёргать её дважды за одно и
   * то же незачем. Но перепроверка по требованию — «ограничение сняли, гляньте
   * заново» — обязана пройти, не дожидаясь завтра.
   */
  async triggerSweepNow(options?: { force?: boolean }): Promise<void> {
    const data: SweepData =
      options?.force === true ? { bucket: `force.${String(this.time.monotonicMs())}` } : {};
    await this.requireQueue().add(JOB_SWEEP, data);
  }

  /**
   * Дождаться, пока очередь доработает. Только для тестов и ручных прогонов.
   *
   * Отложенные задачи считаются не все: в `delayed` вечно лежит следующая
   * итерация суточного расписания, и по ней очередь «непуста» всегда. Её видно
   * по repeatJobKey — она порождена расписанием, а не ретраем. А вот задача,
   * ушедшая ждать повторной попытки, работой считается: без этого ожидание
   * заканчивается раньше работы, и тест зеленеет на полпути.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    const queue = this.requireQueue();
    const deadline = this.time.monotonicMs() + timeoutMs;

    for (;;) {
      const counts = await queue.getJobCounts('waiting', 'active', 'prioritized');
      const delayed = await queue.getDelayed();
      const awaitingRetry = delayed.filter((job) => job.repeatJobKey === undefined).length;

      const pending =
        (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['prioritized'] ?? 0);
      if (pending + awaitingRetry === 0) {
        return;
      }
      if (this.time.monotonicMs() > deadline) {
        throw new Error(`Очередь ${REGISTRY_QUEUE} не опустела за ${String(timeoutMs)} мс`);
      }
      await sleep(50);
    }
  }

  private async process(job: Job): Promise<unknown> {
    if (job.name === JOB_SWEEP) {
      return this.sweep((job.data as SweepData).bucket);
    }
    if (job.name === JOB_CHECK_LOT) {
      const { lotId } = job.data as CheckLotData;
      return this.recheck.recheckLot(lotId);
    }
    throw new Error(`Неизвестная задача очереди ${REGISTRY_QUEUE}: ${job.name}`);
  }

  /** Обход: по задаче на каждый активный лот. */
  private async sweep(bucket?: string): Promise<{ enqueued: number }> {
    const lotIds = await this.recheck.listActiveLotIds();
    const queue = this.requireQueue();

    // Метка прогона. По умолчанию — сутки: повторный обход в тот же день не
    // заводит вторую проверку одного лота, BullMQ отбрасывает add() с уже
    // известным jobId. Расписание ходит раз в 24 часа, поэтому штатные тики
    // всегда попадают в разные метки и друг другу не мешают.
    const key = bucket ?? new Date(this.time.wallClockMs()).toISOString().slice(0, 10);

    await queue.addBulk(
      lotIds.map((lotId) => ({
        name: JOB_CHECK_LOT,
        data: { lotId } satisfies CheckLotData,
        opts: {
          // Разделитель — точка, а не двоеточие. BullMQ двоеточия в id задачи
          // запрещает: сейчас проверка пропускает ровно три части ради
          // совместимости со старым форматом, но в их коде стоит пометка
          // заменить её на прямой запрет. Строить ключ на этом послаблении
          // значит однажды получить падение очереди при обновлении версии.
          jobId: `${JOB_CHECK_LOT}.${lotId}.${key}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Выполненные держим сутки — на них держится защита от повтора по jobId.
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      })),
    );

    this.logger.log(`Обход реестра: поставлено проверок — ${String(lotIds.length)}`);
    return { enqueued: lotIds.length };
  }

  private requireQueue(): Queue {
    if (this.queue === null) {
      throw new Error('Очередь ещё не поднята: onModuleInit не отработал');
    }
    return this.queue;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
