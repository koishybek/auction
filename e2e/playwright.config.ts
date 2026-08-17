import { defineConfig, devices } from '@playwright/test';

import {
  API_METRICS_PORT,
  API_PORT,
  API_URL,
  GATEWAY_METRICS_PORT,
  GATEWAY_PORT,
  stackEnv,
  WEB_PORT,
  WEB_URL,
} from './stack';

/**
 * Браузерная приёмка (T-039, T-040, QA-03).
 *
 * Часть DoD в плане звучит как «визуальный e2e» и «модалка у всех клиентов
 * комнаты» — такое не проверяется юнит-тестом чистой функции. Здесь поднимается
 * весь контур: API, gateway и web, а тест ходит настоящим браузером.
 *
 * Параллельность выключена: тесты доводят лоты до торгов и чистят базу между
 * файлами, а параллельные прогоны затирали бы друг друга.
 */
export default defineConfig({
  testDir: './tests',
  // Воркер поднимается здесь, а не в webServer: у него нет HTTP-порта, а
  // webServer умеет ждать только адрес. Без воркера торги не закрываются.
  globalSetup: './worker-process.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] === undefined ? [['list']] : [['github'], ['list']],

  use: {
    baseURL: WEB_URL,
    // Следы только у упавших: гигабайты видео от зелёного прогона никому не нужны.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../apps/api',
      url: `${API_URL}/api/health`,
      // Порт метрик свой у каждого процесса: на одной машине общий занят соседом.
      env: { ...stackEnv(), METRICS_PORT: String(API_METRICS_PORT) },
      timeout: 90_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node dist/main.gateway.js',
      cwd: '../apps/api',
      url: `http://127.0.0.1:${String(GATEWAY_PORT)}/health`,
      env: { ...stackEnv(), METRICS_PORT: String(GATEWAY_METRICS_PORT) },
      timeout: 90_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      /**
       * web — собранный, а не dev-сервер.
       *
       * Дело не в скорости: сборка всё равно делается в globalSetup, и
       * dev-сервер, поднятый поверх готового `.next`, отдаёт клиентские чанки
       * с 403. Страница приходит отрендеренной сервером и выглядит целой, но
       * не гидратируется — ни один эффект не выполняется, сокет торгов не
       * открывается, и тест видит «нет связи» при живом gateway. Причина при
       * этом совершенно не там, где её ищешь.
       *
       * Заодно это и есть тот контур, который поедет в прод.
       */
      command: `pnpm exec next start -p ${String(WEB_PORT)}`,
      cwd: '../apps/web',
      url: WEB_URL,
      env: {
        ...stackEnv(),
        NODE_ENV: 'production',
        PORT: String(WEB_PORT),
        API_PORT: String(API_PORT),
      },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
