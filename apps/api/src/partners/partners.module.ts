import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TimeModule } from '../time/time.module';

import { LeadsService } from './leads.service';
import { PartnersController } from './partners.controller';

/**
 * Партнёры-риелторы: лиды и закрепление объектов (FR-18).
 *
 * CryptoModule здесь не импортируется: он глобальный, и его подключает корневой
 * модуль процесса (CLAUDE.md, раздел 3).
 */
@Module({
  imports: [PrismaModule, TimeModule],
  controllers: [PartnersController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class PartnersModule {}
