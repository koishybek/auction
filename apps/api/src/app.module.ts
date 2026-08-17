import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { AdminModule } from './admin/admin.module';
import { AntibotModule } from './antibot/antibot.module';
import { AuctionModule } from './auction/auction.module';
import { AuthModule } from './auth/auth.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { CoreModule } from './core.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { LotsModule } from './lots/lots.module';
import { MetricsModule } from './metrics/metrics.module';
import { PartnersModule } from './partners/partners.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TimeModule } from './time/time.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // Конфиг и логирование — общие с фоновым воркером, см. core.module.ts.
    CoreModule,

    PrismaModule,
    RedisModule,
    CryptoModule,
    TimeModule,
    MetricsModule,
    AuthModule,
    UsersModule,
    AdminModule,
    LotsModule,
    AuctionModule,
    AntibotModule,
    PartnersModule,
    DocumentsModule,
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
