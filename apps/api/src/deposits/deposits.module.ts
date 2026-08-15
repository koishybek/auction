import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TimeModule } from '../time/time.module';

import { DepositsService } from './deposits.service';

/**
 * Задатки.
 *
 * О банках не знает: платежи ходят через адаптер (T-035), здесь только учёт и
 * статусы. Движок торгов, в свою очередь, не знает о задатках ничего, кроме
 * одного вопроса — допущен ли участник (CLAUDE.md, раздел 3).
 */
@Module({
  imports: [PrismaModule, TimeModule],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
