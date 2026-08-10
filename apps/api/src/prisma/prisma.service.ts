import { PrismaPg } from '@prisma/adapter-pg';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Единственная точка доступа к PostgreSQL.
 *
 * Приложение ходит через пулер (DATABASE_URL). Миграции сюда не заходят вовсе —
 * они выполняются отдельной Job до старта подов и по DIRECT_URL, потому что DDL
 * и advisory-локи через PgBouncer в transaction-режиме не работают.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL подключён');
  }

  async onModuleDestroy(): Promise<void> {
    // Без явного отключения под в Kubernetes уходит по SIGTERM, оставив
    // соединения висеть до таймаута на стороне БД.
    await this.$disconnect();
  }
}
