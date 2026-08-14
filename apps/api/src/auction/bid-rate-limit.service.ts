import { Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import type { RedisScript } from '../redis/redis-script';

/**
 * Окно лимита: не чаще одной ставки в 500 мс (ТЗ §3.2, FR-10).
 *
 * Значение из ТЗ и не выносится в конфиг: это не тюнинг производительности, а
 * правило торгов. Человек физически не кликает чаще двух раз в секунду —
 * всё, что быстрее, это автокликер.
 */
const WINDOW_MS = 500;

/**
 * Атомарная отметка попытки.
 *
 * SET NX PX — одной командой: проверка «не было ли недавно» и установка метки
 * не должны разъезжаться, иначе два одновременных запроса пройдут оба, а
 * именно от них лимит и защищает.
 *
 * Возвращает остаток окна в мс, если ставить рано, и 0, если можно.
 *
 * KEYS[1] — ключ отметки, ARGV[1] — окно в мс
 */
const HIT = `
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then
  return 0
end
return redis.call('PTTL', KEYS[1])
`;

/** Кто превысил лимит и на сколько. */
export interface RateVerdict {
  readonly allowed: boolean;
  /** Сколько ждать до следующей попытки, мс. Ноль, если ждать не нужно. */
  readonly retryAfterMs: number;
}

/**
 * Ограничение частоты ставок (T-031, FR-10).
 *
 * Считается по двум ключам сразу — сессии и адресу. По сессии, потому что один
 * человек не должен долбить кнопкой; по адресу, потому что иначе автокликер
 * заводит десять аккаунтов и обходит лимит целиком.
 *
 * Отказ мягкий: превышение — не мошенничество, а нетерпение. Участник получает
 * код и время, через которое можно повторить, и остаётся в торгах.
 */
@Injectable()
export class BidRateLimitService {
  private readonly hitScript: RedisScript;

  constructor(private readonly redis: RedisService) {
    this.hitScript = redis.script(HIT);
  }

  /**
   * Отметить попытку. Ключи проверяются по очереди, но каждый — атомарно.
   *
   * Порядок важен: сессия проверяется первой и только она «тратит» окно, если
   * отказ пришёл от адреса. Иначе сосед по NAT, попавший в лимит адреса, сжигал
   * бы окна всем, кто сидит с ним за одним роутером.
   */
  async hit(input: { sessionId: string; ip: string | null }): Promise<RateVerdict> {
    const bySession = await this.mark(this.redis.key('rate', 'bid', 'session', input.sessionId));
    if (!bySession.allowed) {
      return bySession;
    }
    if (input.ip === null) {
      return bySession;
    }
    return this.mark(this.redis.key('rate', 'bid', 'ip', input.ip));
  }

  private async mark(key: string): Promise<RateVerdict> {
    const remaining = await this.hitScript.run([key], [WINDOW_MS]);
    const retryAfterMs = typeof remaining === 'number' ? remaining : 0;
    return { allowed: retryAfterMs <= 0, retryAfterMs: Math.max(0, retryAfterMs) };
  }
}
