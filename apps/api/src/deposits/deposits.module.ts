import { Module } from '@nestjs/common';

import { BankProviderModule } from '../integrations/bank/bank.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeModule } from '../time/time.module';

import { DepositPaymentsService } from './deposit-payments.service';
import { DepositsService } from './deposits.service';

/**
 * Задатки.
 *
 * Учёт и статусы — в DepositsService, общение с банком — в
 * DepositPaymentsService, и банк виден только через адаптер (T-035). Движок
 * торгов не знает о задатках ничего, кроме одного вопроса — допущен ли
 * участник (CLAUDE.md, раздел 3).
 */
@Module({
  imports: [PrismaModule, TimeModule, BankProviderModule],
  providers: [DepositsService, DepositPaymentsService],
  exports: [DepositsService, DepositPaymentsService],
})
export class DepositsModule {}
