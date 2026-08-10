import { Module } from '@nestjs/common';

import { RegistryModule } from '../integrations/registry/registry.module';

import { AdminLotsController, LotsController } from './lots.controller';
import { LotsService } from './lots.service';
import { OpenHouseController } from './open-house.controller';
import { OpenHouseService } from './open-house.service';

@Module({
  imports: [RegistryModule],
  // OpenHouseController раньше LotsController: его маршруты /lots/:lotId/open-house
  // специфичнее, чем /lots/:id, и не должны перехватываться как id=":lotId".
  controllers: [OpenHouseController, LotsController, AdminLotsController],
  providers: [LotsService, OpenHouseService],
  exports: [LotsService],
})
export class LotsModule {}
