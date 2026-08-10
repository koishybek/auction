// Обязан идти первым: без него декораторы Nest не находят метаданные типов и DI падает.
import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp, setupOpenApi } from './app.setup';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // abortOnError: false — иначе Nest при ошибке старта убивает процесс сам, а
  // буферизованный лог с причиной теряется, и мы получаем молчаливый выход с кодом 1.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  configureApp(app);
  setupOpenApi(app);

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('API_PORT', { infer: true });
  await app.listen(port);

  logger.log(
    { port, env: config.get('NODE_ENV', { infer: true }) },
    `API слушает :${String(port)} — /api/health, /api/docs`,
  );
}

bootstrap().catch((error: unknown) => {
  // Пишем напрямую в stderr: логгер на этот момент может быть ещё не поднят,
  // а падение старта обязано быть видно, а не проглочено.
  console.error('Не удалось запустить API:');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
