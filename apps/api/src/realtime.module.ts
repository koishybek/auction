import { Module } from '@nestjs/common';

import { CryptoModule } from './common/crypto/crypto.module';
import { CoreModule } from './core.module';
import { GatewayModule } from './gateway/gateway.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

/**
 * Корень процесса WebSocket-gateway.
 *
 * Отдельный от AppModule: HTTP-контроллеров, глобальных гвардов и OpenAPI здесь
 * нет — gateway не принимает REST. Общее с API (конфиг, логирование, доступ к
 * PostgreSQL и Redis) приходит теми же модулями, а не их копиями.
 */
/**
 * CryptoModule здесь обязателен, хотя он @Global(): глобальным модуль
 * становится, только будучи импортированным в контейнер. Без него AuthModule
 * не соберёт AuthService, и процесс просто не поднимется.
 */
@Module({
  imports: [CoreModule, PrismaModule, RedisModule, CryptoModule, GatewayModule],
})
export class RealtimeModule {}
