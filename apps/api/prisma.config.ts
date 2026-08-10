import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// .env один на весь воркспейс. Prisma ищет его рядом со схемой и в cwd,
// поэтому корневой подгружаем явно.
loadEnv({ path: resolve(import.meta.dirname, '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Именно DIRECT_URL, а не DATABASE_URL: миграции выполняют DDL и берут
    // advisory-локи, а через пулер в transaction-режиме это не работает.
    // Локально обе строки совпадают, на stage и в проде — разойдутся.
    url: process.env['DIRECT_URL'] ?? '',
  },
});
