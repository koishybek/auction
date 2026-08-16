import { Module } from '@nestjs/common';

import { DepositsModule } from '../deposits/deposits.module';
import { LotsModule } from '../lots/lots.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { PrismaModule } from '../prisma/prisma.module';

import { AuctionStateService } from './auction-state.service';
import { AdminAuctionController, AuctionController } from './auction.controller';
import { AuctionService } from './auction.service';
import { BidAuditService } from './bid-audit.service';
import { BidPlacementService } from './bid-placement.service';
import { BidOutboxService } from './bid-outbox.service';
import { BidService } from './bid.service';
import { BidRateLimitService } from './bid-rate-limit.service';
import { BlindIdService } from './blind-id.service';
import { FinisherService } from './finisher.service';
import { SlaFreezeService } from './sla-freeze.service';

/**
 * Движок торгов.
 *
 * Про банки и задатки он не знает ничего и знать не должен: деньги ходят через
 * deposits/payments (CLAUDE.md, раздел 3). Здесь только цена, дедлайн, seq и
 * статус сессии.
 */
@Module({
  imports: [PrismaModule, LotsModule, NotificationsModule, DepositsModule, PartnersModule],
  controllers: [AuctionController, AdminAuctionController],
  providers: [
    AuctionService,
    AuctionStateService,
    BidService,
    BidPlacementService,
    FinisherService,
    BidOutboxService,
    BlindIdService,
    BidRateLimitService,
    BidAuditService,
    SlaFreezeService,
  ],
  exports: [
    SlaFreezeService,
    AuctionService,
    AuctionStateService,
    BidService,
    BidPlacementService,
    FinisherService,
    BidOutboxService,
  ],
})
export class AuctionModule {}
