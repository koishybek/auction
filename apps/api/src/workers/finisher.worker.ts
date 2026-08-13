import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { FinisherService } from '../auction/finisher.service';
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
  private running = false;

  constructor(
    private readonly finisher: FinisherService,
    private readonly time: TimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref();
    this.logger.log(`Finisher поднят: проверка дедлайнов каждые ${String(SWEEP_MS)} мс`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
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
