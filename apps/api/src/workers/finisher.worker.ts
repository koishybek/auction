import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { FinisherService } from '../auction/finisher.service';
import { SlaFreezeService } from '../auction/sla-freeze.service';
import { MetricsService } from '../metrics/metrics.service';
import { TimeService } from '../time/time.service';

/**
 * Как часто проверяются истёкшие дедлайны.
 *
 * 250 мс — компромисс между «участник видит закрытие сразу» и нагрузкой. Хуже
 * этого значения задержка закрытия быть не может, а стоит проверка одного
 * ZRANGEBYSCORE: при пустом индексе она не делает вообще ничего.
 */
const SWEEP_MS = 250;

/**
 * Как часто дозакрываются финиши, не доехавшие в PostgreSQL.
 *
 * Реже основного прохода: это путь на случай сбоя базы, а не штатный. Пять
 * секунд — потому что на незафиксированном финише стоят возвраты задатков и
 * протокол торгов, и держать их часами нельзя.
 */
const RETRY_MS = 5_000;

/**
 * Воркер завершения торгов (T-027).
 *
 * Обычный интервал, а не задача BullMQ, — и это осознанно. Крон BullMQ хорош
 * там, где период измеряется минутами и часами; здесь нужна реакция в доли
 * секунды, и накладные расходы на постановку задачи в очередь каждые 250 мс
 * превысили бы саму работу. Идемпотентность при этом обеспечивает не очередь,
 * а атомарный скрипт: несколько реплик воркера безопасны, закрыть лот дважды
 * физически нельзя.
 */
@Injectable()
export class FinisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FinisherWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;
  private retrying = false;

  constructor(
    private readonly finisher: FinisherService,
    private readonly freeze: SlaFreezeService,
    private readonly time: TimeService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref();
    this.retryTimer = setInterval(() => {
      void this.retry();
    }, RETRY_MS);
    this.retryTimer.unref();
    this.logger.log(`Finisher поднят: проверка дедлайнов каждые ${String(SWEEP_MS)} мс`);
  }

  onModuleDestroy(): void {
    for (const timer of [this.timer, this.retryTimer]) {
      if (timer !== null) {
        clearInterval(timer);
      }
    }
    this.timer = null;
    this.retryTimer = null;
  }

  /**
   * Дозакрыть финиши, не доехавшие в PostgreSQL, и отдать их число в метрику.
   *
   * Метрика важна не меньше самой попытки: если дозакрыть не удаётся, число
   * держится ненулевым — и это единственный способ узнать, что у лота нет
   * ни возврата задатков, ни протокола.
   */
  async retry(): Promise<number> {
    if (this.retrying) {
      return 0;
    }
    this.retrying = true;
    try {
      const fixed = await this.finisher.retryUnpersisted();
      this.metrics.setFinishUnpersisted(await this.finisher.unpersistedCount());
      return fixed;
    } catch (error) {
      this.logger.error(
        `Дозакрытие финишей не удалось: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.retrying = false;
    }
  }

  /**
   * Один проход. Перекрытия исключены флагом: медленный проход не должен
   * запускать поверх себя второй — они начали бы разбирать один и тот же
   * список лотов и жечь Redis впустую.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      /**
       * Возобновление идёт ПЕРЕД закрытием, и порядок здесь существенный.
       *
       * Замороженный лот не лежит в индексе дедлайнов, поэтому finisher его не
       * видит. Но лот, у которого пауза только что истекла, обязан сначала
       * вернуться в торги со своим остатком — и лишь потом, если остаток уже
       * нулевой, быть закрытым. Обратный порядок откладывал бы закрытие на
       * лишний проход.
       */
      await this.freeze.resumeDue(this.time.wallClockMs());

      const finished = await this.finisher.finishDue(this.time.wallClockMs());
      return finished.length;
    } catch (error) {
      // Проход мог упасть на одном лоте — следующий через 250 мс разберёт
      // остальные. Ронять воркер из-за одного лота нельзя: на нём висят все.
      this.logger.error(
        `Проход finisher'а не удался: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
