import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { ProtocolService } from '../documents/protocol.service';

/**
 * Как часто ищутся закрытые сессии без протокола.
 *
 * Пять секунд: документ нужен вскоре после торгов, но не в ту же миллисекунду —
 * сначала должны доехать ставки. Считать протокол в самом finisher'е нельзя
 * ровно поэтому: он закрывает торги раньше, чем последняя ставка попадает в
 * PostgreSQL, и документ вышел бы неполным.
 */
const SWEEP_MS = 5_000;

/**
 * Формирование протоколов торгов (T-044, FR-06).
 *
 * Каждый заход берёт закрытые сессии без документа и пробует собрать протокол.
 * Сессия, у которой ставки ещё не все в базе, пропускается и подхватывается
 * следующим заходом — официальный документ лучше сделать позже, чем неполным.
 */
@Injectable()
export class ProtocolWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProtocolWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly protocols: ProtocolService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref();
    this.logger.log(`Протоколы торгов: разбор каждые ${String(SWEEP_MS)} мс`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Один заход. Возвращает число сформированных протоколов. */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      let made = 0;
      for (const sessionId of await this.protocols.pendingSessions()) {
        if ((await this.protocols.generateIfComplete(sessionId)) !== null) {
          made += 1;
        }
      }
      return made;
    } catch (error) {
      this.logger.error(
        `Формирование протоколов не удалось: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
