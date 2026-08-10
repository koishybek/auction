import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

// .env лежит в корне воркспейса — один файл на api и web. Next по умолчанию
// смотрит только в свою директорию, поэтому подгружаем явно.
loadEnv({ path: resolve(import.meta.dirname, '../../.env') });

const apiPort = process.env['API_PORT'] ?? '3100';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Пакет воркспейса собирается в CJS; Next должен прогнать его через свой конвейер.
  transpilePackages: ['@auction/shared'],

  env: {
    // Адрес API для SSR-запросов. Наружу, в браузер, не отдаётся: обращения к API
    // с сервера, чтобы внутренний адрес не светился в клиентском бандле.
    API_BASE_URL: process.env['API_BASE_URL'] ?? `http://127.0.0.1:${apiPort}`,
  },
};

export default nextConfig;
