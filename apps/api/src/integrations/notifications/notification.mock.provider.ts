import { Injectable, Logger } from '@nestjs/common';

import type {
  NotificationProvider,
  NotificationRequest,
  NotificationResult,
} from './notification.types';

/**
 * Мок провайдера Push/SMS.
 *
 * Ничего не отправляет, но записывает всё, что просили отправить: на этом
 * держится приёмка (DoD T-033 — «в мок-провайдере фиксируются отправки всем
 * участникам лота»), и на этом же удобно смотреть в разработке, кому и что
 * ушло бы в проде.
 */
@Injectable()
export class NotificationMockProvider implements NotificationProvider {
  private readonly logger = new Logger(NotificationMockProvider.name);
  private readonly outbox: NotificationRequest[] = [];
  private failNext = false;

  send(request: NotificationRequest): Promise<NotificationResult> {
    this.outbox.push(request);

    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({ delivered: false, error: 'мок: отправка отклонена' });
    }

    // Телефон в лог не пишем никогда, даже в разработке: логи переживают
    // сессию и уезжают в системы сбора (CLAUDE.md §4.5).
    this.logger.debug(
      `${request.channel} → ${request.userId}: ${request.template} (${request.priority})`,
    );
    return Promise.resolve({ delivered: true, externalId: `mock-${String(this.outbox.length)}` });
  }

  /** Что просили отправить. Только для тестов и ручных проверок. */
  sent(): readonly NotificationRequest[] {
    return this.outbox;
  }

  /** Отправки конкретному участнику. */
  sentTo(userId: string): readonly NotificationRequest[] {
    return this.outbox.filter((request) => request.userId === userId);
  }

  /** Заставить следующую отправку провалиться — проверка ветки недоставки. */
  failOnce(): void {
    this.failNext = true;
  }

  reset(): void {
    this.outbox.length = 0;
    this.failNext = false;
  }
}
