import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/** Глобальный: к БД обращается почти каждый модуль, кроме движка торгов. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
