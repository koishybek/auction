// Обязан идти первым: без него декораторы Nest не находят метаданные типов и DI падает.
import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import type { Env } from './config/env.schema';
import { WsGatewayService } from './gateway/ws-gateway.service';
import { RealtimeModule } from './realtime.module';

/**
 * Процесс WebSocket-gateway: комнаты лотов, снимки состояния, мост pub/sub.
 *
 * Приложение поднимается как standalone-контекст: собственный HTTP-сервер
 * заводит сам gateway — под сокеты и под пробу живости. Второй сервер от Nest
 * здесь был бы лишним портом.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RealtimeModule, {
    bufferLogs: true,
    abortOnError: false,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  // По SIGTERM надо закрыть сокеты, а не оборвать их: клиент увидит нормальное
  // закрытие и переподключится к другому инстансу, забрав свежий снимок.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = await app.get(WsGatewayService).listen();

  logger.log(
    { port, env: config.get('NODE_ENV', { infer: true }) },
    `WS-gateway слушает :${String(port)} — /health для проб`,
  );
}

bootstrap().catch((error: unknown) => {
  // Пишем напрямую в stderr: логгер на этот момент может быть ещё не поднят,
  // а падение старта обязано быть видно, а не проглочено.
  console.error('Не удалось запустить WS-gateway:');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
