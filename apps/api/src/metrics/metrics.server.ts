import { createServer, type Server } from 'node:http';

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';

import { MetricsService } from './metrics.service';

/**
 * Отдельный HTTP-порт для сбора метрик (T-053).
 *
 * Почему не ручка `/api/metrics` в самом API: ingress публикует наружу весь
 * префикс `/api` (см. infra/helm/.../ingress.yaml), и метрики оказались бы в
 * интернете. Наружу они не нужны никому, кроме атакующего: размеры комнат,
 * поток ставок и разбивка отказов по кодам — это карта того, где у системы
 * тонко. Отдельный порт не описан в ingress вообще, поэтому снаружи
 * недостижим — это свойство конфигурации, а не проверки в коде.
 *
 * Второй смысл — общий вход для всех трёх процессов. У воркера HTTP-слоя нет
 * вовсе, а метрики (перенос ставок, finisher, возвраты) у него есть.
 */
@Injectable()
export class MetricsServer implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsServer.name);
  private readonly defaultPort: number;
  private server: Server | null = null;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultPort = config.get('METRICS_PORT', { infer: true });
  }

  /**
   * Поднять слушателя. Возвращает фактический порт.
   *
   * Порт аргументом, а не только из конфига: в одном процессе может подняться
   * два инстанса (тесты gateway так и делают), и второй обязан уметь встать на
   * свободный порт, а не падать на занятом.
   */
  async listen(port: number = this.defaultPort): Promise<number> {
    const server = createServer((request, response) => {
      if (request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      void this.metrics
        .scrape()
        .then(({ body, contentType }) => {
          response.writeHead(200, { 'content-type': contentType });
          response.end(body);
        })
        .catch((error: unknown) => {
          // Сбор метрик не должен ронять процесс: Prometheus переживёт
          // пропущенный скрейп, а перезапуск пода посреди торгов — нет.
          this.logger.error(
            `Не удалось собрать метрики: ${error instanceof Error ? error.message : String(error)}`,
          );
          response.writeHead(500).end();
        });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        resolve();
      });
    });

    this.server = server;
    const address = server.address();
    const actual = typeof address === 'object' && address !== null ? address.port : port;
    this.logger.log(`Метрики на :${String(actual)}/metrics`);
    return actual;
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
