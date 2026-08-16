import type { BehaviorSignals } from '@auction/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CAPTCHA_PROVIDER, type CaptchaProvider } from '../integrations/captcha/captcha.types';
import { RedisService } from '../redis/redis.service';

import { assessBehavior } from './behavior';

/**
 * Сколько держится требование пройти капчу.
 *
 * Пять минут: достаточно, чтобы человек решил её и вернулся к торгам, и мало,
 * чтобы случайная эскалация не выбросила участника из лота насовсем. Лот живёт
 * минуты — санкция на час означала бы «до конца торгов».
 */
const CHALLENGE_TTL_SEC = 300;

/**
 * Поведенческий антибот (T-049, FR-11, ОВ-5).
 *
 * Работает санкцией на СЕССИЮ, а не на пользователя и не на адрес. На
 * пользователя — значит наказать человека за один странный клик; на адрес —
 * значит выбить весь офис или всех за одним NAT (та же оговорка, что у лимита
 * частоты FR-10).
 *
 * Санкция мягкая по построению: не запрет, а требование доказать, что ты
 * человек. Эвристика по одному клику ошибается, и цена её ошибки —
 * потерянный лот у живого участника.
 */
@Injectable()
export class AntibotService {
  private readonly logger = new Logger(AntibotService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(CAPTCHA_PROVIDER) private readonly captcha: CaptchaProvider,
  ) {}

  /**
   * Нужна ли капча этой сессии прямо сейчас.
   *
   * Проверяется ДО оценки поведения: раз человека уже попросили пройти
   * проверку, следующие клики не должны её отменять сами собой.
   */
  async challengeRequired(sessionId: string): Promise<boolean> {
    return (await this.redis.client.exists(this.key(sessionId))) === 1;
  }

  /**
   * Оценить клик и, если он похож на автоматический, потребовать капчу.
   *
   * Возвращает `true`, если ставку принимать нельзя.
   */
  async shouldChallenge(input: {
    sessionId: string;
    lotId: string;
    signals: BehaviorSignals | null;
  }): Promise<boolean> {
    if (await this.challengeRequired(input.sessionId)) {
      return true;
    }

    const assessment = assessBehavior(input.signals);
    if (assessment.verdict === 'HUMAN') {
      if (assessment.reasons.length > 0) {
        // Наблюдения по движению решения не меняют, но пишутся: по ним будут
        // настраиваться пороги, когда появится статистика настоящих торгов.
        this.logger.debug(
          `Сессия ${input.sessionId}: клик принят с оговорками — ${assessment.reasons.join(', ')}`,
        );
      }
      return false;
    }

    await this.redis.client.set(
      this.key(input.sessionId),
      assessment.reasons.join(','),
      'EX',
      CHALLENGE_TTL_SEC,
    );
    this.logger.warn(
      `Сессия ${input.sessionId} на лоте ${input.lotId}: требуется капча — ` +
        assessment.reasons.join(', '),
    );
    return true;
  }

  /**
   * Снять требование капчи предъявленным токеном.
   *
   * Токен проверяет провайдер, а не мы: своя проверка «похоже на решённое»
   * была бы ровно тем, что обходит автомат.
   */
  async solve(input: {
    sessionId: string;
    token: string;
    remoteIp: string | null;
  }): Promise<boolean> {
    const result = await this.captcha.verify({ token: input.token, remoteIp: input.remoteIp });
    if (!result.ok) {
      this.logger.warn(
        `Сессия ${input.sessionId}: капча не принята (${result.code ?? 'нет кода'})`,
      );
      return false;
    }
    await this.redis.client.del(this.key(input.sessionId));
    return true;
  }

  private key(sessionId: string): string {
    return this.redis.key('antibot', 'challenge', sessionId);
  }
}
