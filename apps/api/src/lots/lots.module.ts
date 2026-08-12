import { Module } from '@nestjs/common';

import { RegistryModule } from '../integrations/registry/registry.module';
import { StorageModule } from '../integrations/storage/storage.module';

import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { LotViewsService } from './lot-views.service';
import { AdminLotsController, LotsController } from './lots.controller';
import { LotsService } from './lots.service';
import { OpenHouseController } from './open-house.controller';
import { OpenHouseService } from './open-house.service';

@Module({
  imports: [RegistryModule, StorageModule],
  // Вложенные маршруты (/lots/:lotId/open-house, /lots/:lotId/documents) объявлены
  // раньше LotsController: они специфичнее, чем /lots/:id, и не должны
  // перехватываться как id="open-house".
  controllers: [OpenHouseController, DocumentsController, LotsController, AdminLotsController],
  providers: [LotsService, OpenHouseService, DocumentsService, LotViewsService],
  exports: [LotsService, LotViewsService],
})
export class LotsModule {}
