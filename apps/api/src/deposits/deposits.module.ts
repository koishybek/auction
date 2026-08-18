import { Module } from '@nestjs/common';

import { BankProviderModule } from '../integrations/bank/bank.module';
import { PartnersModule } from '../partners/partners.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeModule } from '../time/time.module';

import { DepositPaymentsService } from './deposit-payments.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { RefundService } from './refund.service';
import { RunnerUpService } from './runner-up.service';

/**
 * Задатки.
 *
 * Учёт и статусы — в DepositsService, общение с банком — в
 * DepositPaymentsService, и банк виден только через адаптер (T-035). Движок
 * торгов не знает о задатках ничего, кроме одного вопроса — допущен ли
 * участник (CLAUDE.md, раздел 3).
 */
@Module({
  imports: [
    PrismaModule,
    TimeModule,
    BankProviderModule,
    // Ради бонуса партнёра: сверка закрытых лотов дозакрывает и его — тем же
    // заходом, что и возвраты (T-055).
    PartnersModule,
  ],
  controllers: [DepositsController],
  providers: [DepositsService, DepositPaymentsService, RefundService, RunnerUpService],
  exports: [DepositsService, DepositPaymentsService, RefundService, RunnerUpService],
})
export class DepositsModule {}
