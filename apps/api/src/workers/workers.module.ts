import { Module } from '@nestjs/common';

import { AuctionModule } from '../auction/auction.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { RegistryModule } from '../integrations/registry/registry.module';
import { LotsModule } from '../lots/lots.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeModule } from '../time/time.module';

import { FinisherWorker } from './finisher.worker';
import { RegistryRecheckService } from './registry-recheck.service';
import { RegistryRecheckWorker } from './registry-recheck.worker';

/**
 * Фоновые задачи (BullMQ).
 *
 * Поднимается только в процессе воркера (`main.worker.ts`), не в API. Причина
 * не в чистоте: обход реестра ходит во внешнюю госсистему и ждёт ответа
 * секундами, и делать это в процессе, который обязан отвечать на ставки за
 * миллисекунды, нельзя. В Kubernetes это отдельный Deployment, который
 * масштабируется и падает независимо от API.
 *
 * LotsModule импортируется ради LotsService: смена статуса лота идёт через
 * единственную точку с таблицей переходов и записью в audit_log — у крона нет
 * привилегии менять статус в обход правил.
 */
@Module({
  imports: [PrismaModule, CryptoModule, TimeModule, RegistryModule, LotsModule, AuctionModule],
  providers: [RegistryRecheckService, RegistryRecheckWorker, FinisherWorker],
  exports: [RegistryRecheckService, RegistryRecheckWorker, FinisherWorker],
})
export class WorkersModule {}
