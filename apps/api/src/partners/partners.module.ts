import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeModule } from '../time/time.module';

import { LeadsService } from './leads.service';
import { PartnersController } from './partners.controller';
import { RefBonusService } from './ref-bonus.service';

/**
 * Партнёры-риелторы: лиды и закрепление объектов (FR-18).
 *
 * CryptoModule здесь не импортируется: он глобальный, и его подключает корневой
 * модуль процесса (CLAUDE.md, раздел 3).
 */
@Module({
  imports: [PrismaModule, TimeModule, NotificationsModule],
  controllers: [PartnersController],
  providers: [LeadsService, RefBonusService],
  exports: [LeadsService, RefBonusService],
})
export class PartnersModule {}
