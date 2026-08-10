import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import { CryptoModule } from './common/crypto/crypto.module';
import { validateEnv, type Env } from './config/env.schema';
import { HealthModule } from './health/health.module';
import { TimeModule } from './time/time.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // .env лежит в корне воркспейса: одна конфигурация на api и web.
      envFilePath: resolve(__dirname, '../../../.env'),
      validate: validateEnv,
      cache: true,
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('NODE_ENV', { infer: true }) === 'production' ? 'info' : 'debug',

          // Структурный JSON — формат по умолчанию. pino-pretty только для локальной отладки.
          // Ключ добавляется условно, а не выставляется в undefined: при
          // exactOptionalPropertyTypes это разные вещи.
          ...(config.get('LOG_PRETTY', { infer: true })
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'HH:MM:ss.l' },
                },
              }
            : {}),

          // Сквозной идентификатор запроса: без него в логах 50 000 клиентов
          // невозможно проследить судьбу одной ставки.
          genReqId: (req, res) => {
            const existing = req.headers['x-request-id'];
            const id = typeof existing === 'string' && existing !== '' ? existing : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },

          // ПДн и секреты не попадают в логи ни при каких обстоятельствах (CLAUDE.md §4.5).
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.iin',
              'req.body.phone',
            ],
            censor: '[скрыто]',
          },

          // Проверки живости стучатся раз в несколько секунд — в логах от них один шум.
          autoLogging: {
            ignore: (req) => req.url === '/health' || req.url === '/health/ready',
          },
        },
      }),
    }),

    CryptoModule,
    TimeModule,
    HealthModule,
  ],

  providers: [
    /**
     * Единственный валидирующий пайп приложения. Схема Zod — единственный
     * источник истины: из неё же выводится тип DTO (createZodDto) и схема OpenAPI.
     *
     * Регистрируем через APP_PIPE, а не app.useGlobalPipes в main.ts: тогда пайп
     * поднимается вместе с модулем, и e2e-тесты гоняют ровно те же правила, что прод.
     *
     * Аналог forbidNonWhitelisted — .strict() на схеме запроса. Zod по умолчанию
     * молча выбрасывает лишние ключи, а нам нужен отказ: попытка протащить лишнее
     * поле в ставку обязана быть видна (QA-04).
     */
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
