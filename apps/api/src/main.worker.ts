// Обязан идти первым: без него декораторы Nest не находят метаданные типов и DI падает.
import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import type { Env } from './config/env.schema';
import { WorkerModule } from './worker.module';

/**
 * Процесс фоновых задач: крон реестра (T-020), в дальнейшем finisher торгов,
 * возвраты задатков и снятие карантина.
 *
 * Приложение поднимается как standalone — без HTTP-сервера. Порт воркеру не
 * нужен, а открытый и никем не используемый порт в кластере лишний.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  // Без этого под в Kubernetes умирает по SIGTERM, бросив задачу на полпути:
  // воркер должен успеть закрыть очередь и вернуть незавершённое обратно.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  logger.log(
    { env: config.get('NODE_ENV', { infer: true }) },
    'Воркер поднят: фоновые задачи запущены',
  );
}

bootstrap().catch((error: unknown) => {
  // Пишем напрямую в stderr: логгер на этот момент может быть ещё не поднят,
  // а падение старта обязано быть видно, а не проглочено.
  console.error('Не удалось запустить воркер:');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
