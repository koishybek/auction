import { Module } from '@nestjs/common';

import { StorageModule } from '../integrations/storage/storage.module';
import { PrismaModule } from '../prisma/prisma.module';

import { ProtocolController } from './protocol.controller';
import { ProtocolService } from './protocol.service';
import { VetoActService } from './veto-act.service';

/**
 * Документы торгов: протокол, дальше — Акт ВЕТО (T-045).
 *
 * Отдельно от `lots/documents` (Data Room) намеренно: те файлы загружает
 * продавец, эти формирует система, и правила доступа у них разные.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [ProtocolController],
  providers: [ProtocolService, VetoActService],
  exports: [ProtocolService, VetoActService],
})
export class DocumentsModule {}
