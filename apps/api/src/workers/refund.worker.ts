import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { RefundService } from '../deposits/refund.service';

/**
 * Как часто разбирается очередь возвратов.
 *
 * Пять секунд, а не миллисекунды: SLA возврата — сутки, и торопиться здесь
 * некуда. Но и раз в час нельзя: участник видит статус задатка в кабинете, и
 * «возврат в работе» должен появляться в разумное время после закрытия торгов,
 * а не через час тишины.
 */
const SWEEP_MS = 5_000;

/** Как часто проверяется нарушение SLA. Реже: это отчёт, а не действие. */
const OVERDUE_EVERY = 12;

/**
 * Отправка поручений на возврат задатков (T-037).
 *
 * Живёт в процессе воркеров: поход в банк ждёт ответа секундами, и делать это
 * там, где принимаются ставки, нельзя. Реплик может быть несколько — заявку
 * захватывает одна, это обеспечено условным обновлением в базе, а не
 * договорённостью между процессами.
 */
@Injectable()
export class RefundWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweeps = 0;

  constructor(private readonly refunds: RefundService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref();
    this.logger.log(`Возвраты задатков: разбор каждые ${String(SWEEP_MS)} мс`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Один заход. Перекрытия исключены: медленный банк не должен множить заходы. */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const sent = await this.refunds.triggerDue();
      this.sweeps += 1;
      if (this.sweeps % OVERDUE_EVERY === 0) {
        // Реже, чем отправка: обе проверки — про забытое, а не про срочное.
        await this.refunds.reconcileFinishedLots();
        await this.refunds.overdue();
      }
      return sent;
    } catch (error) {
      // Заявки остались незанятыми и придут следующим заходом.
      this.logger.error(
        `Разбор возвратов не удался: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
