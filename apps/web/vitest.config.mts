import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Тесты web — только для чистой логики (`src/lib`), без DOM и без React.
 *
 * Браузерного харнесса в проекте пока нет; когда он появится (Phase 5, где
 * DoD прямо требует визуальных e2e), он встанет рядом, а не вместо этого.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    env: {},
  },
});
