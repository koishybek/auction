import { Module } from '@nestjs/common';

import { CoreModule } from './core.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WorkersModule } from './workers/workers.module';

/**
 * Корень процесса фоновых задач.
 *
 * Отдельный от AppModule намеренно: у воркера нет HTTP-слоя, контроллеров и
 * гвардов — ему нечего охранять, он не принимает запросов извне. Общее с API
 * (конфиг, логирование, доступ к БД и Redis) приходит теми же модулями, а не
 * их копиями.
 */
@Module({
  imports: [CoreModule, PrismaModule, RedisModule, WorkersModule],
})
export class WorkerModule {}
