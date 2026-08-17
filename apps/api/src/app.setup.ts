import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Application } from 'express';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { clientIpFrom } from './common/http/client-ip';
import type { Env } from './config/env.schema';

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

  /**
   * Сколько прокси перед нами — столько последних записей X-Forwarded-For и
   * считаются доверенными. Ноль (умолчание) означает «адрес берём из сокета».
   *
   * Именно число, а не `true`: заголовок дописывает кто угодно, включая самого
   * клиента. При `trust proxy: true` Express возьмёт самую левую запись — ту,
   * которую прислал клиент, — и подмена адреса становится однострочником.
   * От адреса зависят антинакрутка просмотров и лимит ставок (FR-10).
   */
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  expressApp.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  /**
   * Адрес клиента за Cloudflare (T-050).
   *
   * Подменяем `req.ip` один раз здесь, а не в каждом месте, где адрес нужен:
   * лимит ставок, антинакрутка просмотров, аудит и капча обязаны видеть один
   * и тот же адрес. Разъехавшиеся источники означали бы, что лимит считает
   * одного человека, а аудит записывает другого.
   */
  const trustCloudflare = config.get('TRUST_CLOUDFLARE_IP', { infer: true });
  expressApp.use((request, _response, next) => {
    const resolved = clientIpFrom(request.headers, request.ip ?? null, trustCloudflare);
    if (resolved !== null && resolved !== request.ip) {
      Object.defineProperty(request, 'ip', { get: () => resolved, configurable: true });
    }
    next();
  });
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
