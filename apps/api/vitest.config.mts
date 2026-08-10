import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Именно SWC, а не esbuild по умолчанию: он умеет emitDecoratorMetadata,
    // без которой DI в NestJS не поднимется в тестах (понадобится с T-011).
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Тестам нужны только те переменные, что они себе зададут сами:
    // .env подгружать не хотим, чтобы тест не зависел от машины разработчика.
    env: {},
  },
});
