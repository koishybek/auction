import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

import type { CaptchaProvider, CaptchaVerification } from './captcha.types';

/** Адрес проверки токена. Задан Cloudflare, настройкой не является. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Сколько ждём ответ Cloudflare.
 *
 * Три секунды: капча стоит на пути к ставке, и участник, который её решил, не
 * должен смотреть в зависшую страницу. Не ответили — считаем непройденной:
 * пропускать по таймауту значит открывать обход отключением сети.
 */
const VERIFY_TIMEOUT_MS = 3_000;

/**
 * Cloudflare Turnstile (T-050, ОВ-5).
 *
 * Реализация написана по документированному контракту siteverify, но на
 * настоящих ключах НЕ проверена: аккаунта Cloudflare у проекта пока нет.
 * Подключается заменой провайдера в модуле, когда ключи появятся, — мок при
 * этом остаётся для тестов и локальной разработки.
 */
@Injectable()
export class TurnstileProvider implements CaptchaProvider {
  private readonly logger = new Logger(TurnstileProvider.name);
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('TURNSTILE_SECRET_KEY', { infer: true });
  }

  async verify(input: { token: string; remoteIp: string | null }): Promise<CaptchaVerification> {
    const body = new URLSearchParams({ secret: this.secret, response: input.token });
    if (input.remoteIp !== null) {
      // Тот же токен с другого адреса — признак перепродажи решённых капч.
      body.set('remoteip', input.remoteIp);
    }

    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, code: `HTTP_${String(response.status)}` };
      }

      // Ответ внешней системы — `unknown`, сужаем, а не приводим (CLAUDE.md §4.1).
      const payload: unknown = await response.json();
      const success =
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { success?: unknown }).success === true;

      if (success) {
        return { ok: true };
      }
      const codes = (payload as { 'error-codes'?: unknown })['error-codes'];
      return { ok: false, code: Array.isArray(codes) ? codes.map(String).join(',') : 'REJECTED' };
    } catch (error) {
      // Сеть недоступна или таймаут. Отказ, а не пропуск: иначе обойти капчу
      // можно было бы, оборвав связь с Cloudflare.
      this.logger.error(
        `Turnstile недоступен: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }
}
