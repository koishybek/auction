import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { RefBonusPayoutService } from '../payments/ref-bonus-payout.service';

/**
 * Как часто выплачиваются доли партнёров.
 *
 * Десять секунд: деньги партнёра не горят, но и висеть начисленными сутками
 * не должны — партнёр видит статус в кабинете и ждёт перевода.
 */
const SWEEP_MS = 10_000;

/**
 * Выплата Ref-Bonus (T-047, FR-19).
 *
 * Отдельный проход, а не хвост расщепления доплаты: доля платится из
 * комиссии, а комиссия приходит поручением в банк, и связывать выплату
 * партнёру с успехом одного вызова банка значило бы терять её при любом
 * временном сбое.
 */
@Injectable()
export class RefBonusPayoutWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefBonusPayoutWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly payouts: RefBonusPayoutService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref();
    this.logger.log(`Выплата долей партнёров: разбор каждые ${String(SWEEP_MS)} мс`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      return await this.payouts.payDue();
    } catch (error) {
      this.logger.error(
        `Выплата долей не удалась: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
