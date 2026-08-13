import { Module } from '@nestjs/common';

import { LotsModule } from '../lots/lots.module';
import { PrismaModule } from '../prisma/prisma.module';

import { AuctionStateService } from './auction-state.service';
import { AdminAuctionController, AuctionController } from './auction.controller';
import { AuctionService } from './auction.service';
import { BidPlacementService } from './bid-placement.service';
import { BidOutboxService } from './bid-outbox.service';
import { BidService } from './bid.service';
import { FinisherService } from './finisher.service';

/**
 * Движок торгов.
 *
 * Про банки и задатки он не знает ничего и знать не должен: деньги ходят через
 * deposits/payments (CLAUDE.md, раздел 3). Здесь только цена, дедлайн, seq и
 * статус сессии.
 */
@Module({
  imports: [PrismaModule, LotsModule],
  controllers: [AuctionController, AdminAuctionController],
  providers: [
    AuctionService,
    AuctionStateService,
    BidService,
    BidPlacementService,
    FinisherService,
    BidOutboxService,
  ],
  exports: [
    AuctionService,
    AuctionStateService,
    BidService,
    BidPlacementService,
    FinisherService,
    BidOutboxService,
  ],
})
export class AuctionModule {}
