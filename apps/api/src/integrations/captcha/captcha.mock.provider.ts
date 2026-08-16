import { Injectable, Logger } from '@nestjs/common';

import type { CaptchaProvider, CaptchaVerification } from './captcha.types';

/**
 * Мок капчи (ОВ-5).
 *
 * Пока ключей Turnstile нет, решение принимается по форме токена: всё, что
 * начинается на `solved-`, считается решённой капчей. Этого достаточно, чтобы
 * проверить путь целиком — эскалацию, снятие санкции и повторную ставку, — и
 * ровно ничего не обещает про настоящую защиту.
 */
@Injectable()
export class CaptchaMockProvider implements CaptchaProvider {
  private readonly logger = new Logger(CaptchaMockProvider.name);
  private readonly verified: { token: string; remoteIp: string | null }[] = [];
  private failNext = false;

  verify(input: { token: string; remoteIp: string | null }): Promise<CaptchaVerification> {
    this.verified.push(input);
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({ ok: false, code: 'FORCED_FAILURE' });
    }
    const ok = input.token.startsWith('solved-');
    if (!ok) {
      this.logger.debug('Капча не принята: токен не похож на решённый');
    }
    return Promise.resolve(ok ? { ok } : { ok, code: 'INVALID_TOKEN' });
  }

  /** Следующая проверка провалится, каким бы ни был токен. */
  failVerificationOnce(): void {
    this.failNext = true;
  }

  attempts(): readonly { token: string; remoteIp: string | null }[] {
    return this.verified;
  }

  reset(): void {
    this.verified.length = 0;
    this.failNext = false;
  }
}
