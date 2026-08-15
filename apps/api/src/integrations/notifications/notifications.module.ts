import { Module } from '@nestjs/common';

import { NotificationMockProvider } from './notification.mock.provider';
import { NOTIFICATION_PROVIDER } from './notification.types';

/** Как eGov и реестр: пока мок, реальный провайдер выбирается на Фазе 4 (ОВ-12). */
@Module({
  providers: [
    NotificationMockProvider,
    { provide: NOTIFICATION_PROVIDER, useExisting: NotificationMockProvider },
  ],
  exports: [NOTIFICATION_PROVIDER, NotificationMockProvider],
})
export class NotificationProviderModule {}
