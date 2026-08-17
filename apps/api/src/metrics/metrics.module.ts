import { Global, Module } from '@nestjs/common';

import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';

/**
 * Метрики Prometheus (T-053).
 *
 * `@Global()` по той же причине, что у CryptoModule: измеряемые места
 * разбросаны по модулям (ставка, gateway, воркеры), и тащить импорт в каждый —
 * значит однажды забыть и получить метрику, которой нет ни в одном процессе.
 * Как и там, глобальным модуль становится только будучи импортированным в
 * корень процесса: забудешь — контейнер не соберётся при старте пода.
 */
@Global()
@Module({
  providers: [MetricsService, MetricsServer],
  exports: [MetricsService, MetricsServer],
})
export class MetricsModule {}
