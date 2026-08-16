import { Module } from '@nestjs/common';

import { BankProviderModule } from '../integrations/bank/bank.module';
import { PrismaModule } from '../prisma/prisma.module';

import { PaymentsService } from './payments.service';

/**
 * Доплата победителя и её расщепление (INT-03).
 *
 * Отдельно от задатков: те лежат на спецсчёте и возвращаются, эти расходятся
 * по трём счетам и не возвращаются никогда. Общего у них только банк.
 */
@Module({
  imports: [PrismaModule, BankProviderModule],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
