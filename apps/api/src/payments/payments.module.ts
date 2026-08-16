import { Module } from '@nestjs/common';

import { BankProviderModule } from '../integrations/bank/bank.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';

import { PaymentsService } from './payments.service';
import { RefBonusPayoutService } from './ref-bonus-payout.service';

/**
 * Доплата победителя и её расщепление (INT-03).
 *
 * Отдельно от задатков: те лежат на спецсчёте и возвращаются, эти расходятся
 * по трём счетам и не возвращаются никогда. Общего у них только банк.
 */
@Module({
  imports: [PrismaModule, BankProviderModule, NotificationsModule],
  providers: [PaymentsService, RefBonusPayoutService],
  exports: [PaymentsService, RefBonusPayoutService],
})
export class PaymentsModule {}
