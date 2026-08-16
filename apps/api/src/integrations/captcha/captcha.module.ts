import { Module } from '@nestjs/common';

import { CaptchaMockProvider } from './captcha.mock.provider';
import { CAPTCHA_PROVIDER } from './captcha.types';

/** Как eGov, реестр, банк и уведомления: интерфейс + мок до получения ключей (ОВ-5). */
@Module({
  providers: [CaptchaMockProvider, { provide: CAPTCHA_PROVIDER, useExisting: CaptchaMockProvider }],
  exports: [CAPTCHA_PROVIDER, CaptchaMockProvider],
})
export class CaptchaProviderModule {}
