import { Global, Module } from '@nestjs/common';

import { TimeController } from './time.controller';
import { TimeService } from './time.service';

/**
 * Глобальный: время понадобится движку торгов, воркерам и аудиту.
 * Если его придётся импортировать в каждом модуле, кто-нибудь однажды
 * просто вызовет Date.now() — и таймер начнёт зависеть от прыжков часов.
 */
@Global()
@Module({
  controllers: [TimeController],
  providers: [TimeService],
  exports: [TimeService],
})
export class TimeModule {}
