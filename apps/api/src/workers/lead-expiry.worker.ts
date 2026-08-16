import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { LeadsService } from '../partners/leads.service';

/**
 * Как часто снимаются истёкшие закрепления.
 *
 * Раз в минуту: срок закрепления — 90 дней, и точность до секунды здесь не
 * нужна. Но и раз в сутки нельзя — объект, освободившийся утром, должен стать
 * доступен другому партнёру в тот же день, а не назавтра.
 */
const SWEEP_MS = 60_000;

/**
 * Снятие закреплений лидов по сроку (T-042, FR-18).
 *
 * Дублирует проверку, которая делается при входе в кабинет, и это намеренно:
 * партнёр, который к площадке не заходит, не должен держать объект вечно —
 * иначе закрепление снималось бы только у активных, а лежало бы на пассивных.
 */
@Injectable()
export class LeadExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadExpiryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly leads: LeadsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref();
    this.logger.log(`Снятие закреплений лидов: разбор каждые ${String(SWEEP_MS)} мс`);
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
      return await this.leads.releaseExpired();
    } catch (error) {
      this.logger.error(
        `Снятие закреплений не удалось: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
