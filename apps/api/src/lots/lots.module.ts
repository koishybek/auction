import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { RegistryModule } from '../integrations/registry/registry.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { PartnersModule } from '../partners/partners.module';
import { PaymentsModule } from '../payments/payments.module';

import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { LotViewsService } from './lot-views.service';
import { AdminLotsController, LotsController } from './lots.controller';
import { LotsService } from './lots.service';
import { OpenHouseController } from './open-house.controller';
import { OpenHouseService } from './open-house.service';
import { SellerController } from './seller.controller';
import { SellerService } from './seller.service';
import { VetoController } from './veto.controller';
import { VetoService } from './veto.service';

@Module({
  imports: [RegistryModule, StorageModule, PartnersModule, DocumentsModule, PaymentsModule],
  // Вложенные маршруты (/lots/:lotId/open-house, /lots/:lotId/documents) объявлены
  // раньше LotsController: они специфичнее, чем /lots/:id, и не должны
  // перехватываться как id="open-house".
  controllers: [
    OpenHouseController,
    DocumentsController,
    SellerController,
    VetoController,
    LotsController,
    AdminLotsController,
  ],
  providers: [
    LotsService,
    OpenHouseService,
    DocumentsService,
    LotViewsService,
    SellerService,
    VetoService,
  ],
  exports: [LotsService, LotViewsService],
})
export class LotsModule {}
