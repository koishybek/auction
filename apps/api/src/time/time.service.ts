import { performance } from 'node:perf_hooks';

import type { ServerTimeReport } from '@auction/shared';
import { Injectable } from '@nestjs/common';

/**
 * Единственный источник времени в приложении.
 *
 * Правило: `Date.now()` в бизнес-логике не вызываем. Причина не в стиле —
 * системные часы прыгают. NTP может перевести их назад, виртуалка может
 * «догнать» время после паузы, и если на этих часах считать остаток таймера,
 * уже завершённые торги воскреснут, а завершившиеся честно — оспорят.
 *
 * `monotonicMs` растёт всегда: он привязан к моменту старта процесса и
 * монотонному счётчику, а не к стенным часам.
 */
@Injectable()
export class TimeService {
  /** Стенные часы. Только для отображения, логов и аудита. */
  wallClockMs(): number {
    return Date.now();
  }

  /**
   * Монотонное время в мс от эпохи. Им считаются все интервалы торгов:
   * дедлайны, остаток таймера, длительность сессии.
   */
  monotonicMs(): number {
    return Math.round(performance.timeOrigin + performance.now());
  }

  now(): ServerTimeReport {
    const serverTs = this.wallClockMs();
    return {
      serverTs,
      monotonicMs: this.monotonicMs(),
      iso: new Date(serverTs).toISOString(),
      uptimeSec: Math.floor(process.uptime()),
    };
  }
}
