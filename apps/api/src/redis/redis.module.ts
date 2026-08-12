import { Global, Module } from '@nestjs/common';

import { RedisService } from './redis.service';

/**
 * Глобальный: Redis нужен почти всем модулям торгового контура (auction,
 * deposits, gateway), а соединение обязано быть одно на приложение.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
