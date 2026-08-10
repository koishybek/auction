import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Application } from 'express';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Общая настройка приложения для прода и для e2e.
 *
 * Вынесено в одно место намеренно: если e2e поднимает приложение с другими
 * фильтрами или без префикса, тесты проверяют не то приложение, которое поедет
 * в прод, и зелёный прогон ничего не гарантирует.
 *
 * Валидирующий пайп и гварды сюда не входят — они зарегистрированы в модулях
 * через APP_PIPE и APP_GUARD, поэтому приезжают сами в любом способе запуска.
 */
export function configureApp(app: INestApplication, options?: { shutdownHooks?: boolean }): void {
  /**
   * Весь REST под /api: ingress отправляет в сервис API именно этот префикс,
   * а корень отдаёт web. Без общего префикса маршруты dev и прода разъехались бы.
   */
  app.setGlobalPrefix('api');

  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost), app.get(Logger)));

  // Без этого под в Kubernetes умирает по SIGTERM, обрывая запросы на полуслове.
  // В e2e хуки выключаются: слушатели сигналов переживают app.close() и не дают
  // процессу vitest завершиться.
  if (options?.shutdownHooks !== false) {
    app.enableShutdownHooks();
  }

  // Не сообщаем внешнему миру, на чём работаем: бесплатная подсказка для сканеров.
  const expressApp = app.getHttpAdapter().getInstance() as Application;
  expressApp.disable('x-powered-by');
}

/** OpenAPI. В e2e не нужен, поэтому отдельно от configureApp. */
export function setupOpenApi(app: INestApplication): void {
  const openApi = new DocumentBuilder()
    .setTitle('Цифровой гибридный аукцион скоростных продаж — API')
    .setDescription('REST-контур платформы. Real-time торги идут по WebSocket, см. docs/')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();

  // cleanupOpenApiDoc обязателен: он превращает Zod-схемы DTO в корректные
  // схемы OpenAPI. Без него /docs отдаёт документ с пустыми телами запросов.
  SwaggerModule.setup(
    'docs',
    app,
    () => cleanupOpenApiDoc(SwaggerModule.createDocument(app, openApi)),
    { useGlobalPrefix: true },
  );
}
