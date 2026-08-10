// Обязан идти первым: без него декораторы Nest не находят метаданные типов и DI падает.
import 'reflect-metadata';

import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Application } from 'express';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // abortOnError: false — иначе Nest при ошибке старта убивает процесс сам, а
  // буферизованный лог с причиной теряется, и мы получаем молчаливый выход с кодом 1.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  /**
   * Глобальный пайп настраивается ровно здесь и один раз — те же правила
   * обязаны действовать в e2e-тестах, иначе тесты проверяют не то приложение.
   *
   * forbidNonWhitelisted важнее, чем кажется: он не даёт протащить лишние поля
   * в запрос ставки (QA-04, попытка подмены суммы через DevTools/Postman).
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost), logger));

  // Без этого под в Kubernetes умирает по SIGTERM, обрывая запросы на полуслове.
  app.enableShutdownHooks();

  // Не сообщаем внешнему миру, на чём работаем: бесплатная подсказка для сканеров.
  // getInstance() возвращает any — сужаем до Application, иначе весь вызов
  // становится небезопасным по типам (правило no-unsafe-call).
  const expressApp = app.getHttpAdapter().getInstance() as Application;
  expressApp.disable('x-powered-by');

  const config = app.get(ConfigService<Env, true>);

  const openApi = new DocumentBuilder()
    .setTitle('Цифровой гибридный аукцион скоростных продаж — API')
    .setDescription('REST-контур платформы. Real-time торги идут по WebSocket, см. docs/')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, openApi));

  const port = config.get('API_PORT', { infer: true });
  await app.listen(port);

  logger.log(
    { port, env: config.get('NODE_ENV', { infer: true }) },
    `API слушает :${String(port)} — /health, /docs`,
  );
}

bootstrap().catch((error: unknown) => {
  // Пишем напрямую в stderr: логгер на этот момент может быть ещё не поднят,
  // а падение старта обязано быть видно, а не проглочено.
  console.error('Не удалось запустить API:');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
