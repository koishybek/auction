import { Module } from '@nestjs/common';

import { NotificationProviderModule } from '../integrations/notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';

import { NotificationsService } from './notifications.service';

/**
 * Уведомления участников.
 *
 * Единственная точка, где создаются строки в `notifications`: два способа
 * уведомить означали бы два разных ответа на вопрос «отправляли или нет».
 */
@Module({
  imports: [PrismaModule, NotificationProviderModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
