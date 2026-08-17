import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

import { CaptchaMockProvider } from './captcha.mock.provider';
import { CAPTCHA_PROVIDER, type CaptchaProvider } from './captcha.types';
import { TurnstileProvider } from './turnstile.provider';

/**
 * Капча: мок или настоящий Turnstile (ОВ-5, T-050).
 *
 * Выбор делается по наличию секретного ключа, а не по NODE_ENV. Причина
 * практическая: прод без ключа обязан падать заметно, а не тихо пускать всех
 * через мок, — и наоборот, stage с ключом должен ходить в Cloudflare, даже
 * если запущен не в production-режиме.
 */
@Module({
  providers: [
    CaptchaMockProvider,
    TurnstileProvider,
    {
      provide: CAPTCHA_PROVIDER,
      inject: [ConfigService, CaptchaMockProvider, TurnstileProvider],
      useFactory: (
        config: ConfigService<Env, true>,
        mock: CaptchaMockProvider,
        turnstile: TurnstileProvider,
      ): CaptchaProvider => {
        const secret = config.get('TURNSTILE_SECRET_KEY', { infer: true });
        const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
        if (secret === '') {
          if (isProduction) {
            // Молчаливый мок в проде — это открытая дверь, а не деградация.
            throw new Error('TURNSTILE_SECRET_KEY обязателен в production');
          }
          return mock;
        }
        return turnstile;
      },
    },
  ],
  exports: [CAPTCHA_PROVIDER, CaptchaMockProvider],
})
export class CaptchaProviderModule {}
