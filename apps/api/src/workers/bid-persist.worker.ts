import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { BidOutboxService } from '../auction/bid-outbox.service';

/**
 * Как часто разбирается outbox.
 *
 * 200 мс: ставка должна попасть в базу почти сразу — на неё смотрит лента
 * истории и по ней после закрытия торгов определяется победитель. При пустом
 * потоке заход стоит одного XREADGROUP.
 */
const DRAIN_MS = 200;

/**
 * Перенос ставок из Redis в PostgreSQL (T-028).
 *
 * Отдельный процесс, а не хвост обработчика ставки. Приём ставки обязан
 * укладываться в миллисекунды: там таймер, гонка и пятьдесят тысяч ждущих
 * клиентов. Запись в PostgreSQL к этому бюджету отношения не имеет и потому
 * вынесена за него.
 */
@Injectable()
export class BidPersistWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BidPersistWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly outbox: BidOutboxService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.drain();
    }, DRAIN_MS);
    this.timer.unref();
    this.logger.log(`Перенос ставок поднят: разбор outbox каждые ${String(DRAIN_MS)} мс`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Один заход. Перекрытия исключены: иначе две пачки полезут за одними записями. */
  async drain(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      return await this.outbox.drain();
    } catch (error) {
      // Записи остаются неподтверждёнными и придут следующим заходом —
      // потерять ставку нельзя, а отложить на 200 мс можно.
      this.logger.error(
        `Разбор outbox не удался: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
