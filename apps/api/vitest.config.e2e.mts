import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { resolveTestUrls, TEST_STORAGE_ROOT } from './test/test-db';

// Строки подключения считаются здесь, чтобы попасть в окружение воркеров:
// изменения process.env из globalSetup до них не доезжают.
const { databaseUrl } = resolveTestUrls();

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Тесты чистят таблицы, поэтому параллельные файлы затирали бы друг друга.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      STORAGE_LOCAL_ROOT: TEST_STORAGE_ROOT,
    },
  },
});
