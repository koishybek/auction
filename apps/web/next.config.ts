import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

// .env лежит в корне воркспейса — один файл на api и web. Next по умолчанию
// смотрит только в свою директорию, поэтому подгружаем явно.
loadEnv({ path: resolve(import.meta.dirname, '../../.env') });

const apiPort = process.env['API_PORT'] ?? '3100';
const apiBaseUrl = process.env['API_BASE_URL'] ?? `http://127.0.0.1:${apiPort}`;

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Next по умолчанию генерирует свои AGENTS.md и CLAUDE.md рядом с пакетом.
  // Инструкция проекта одна и лежит в корне (CLAUDE.md): второй файл внутри
  // apps/web подменял бы её правилами о Next вместо правил о деньгах и торгах.
  agentRules: false,

  /**
   * В проде ingress отдаёт /api в сервис API, а / — в web, поэтому браузер
   * обращается к API по относительному пути. В разработке ingress'а нет, и его
   * роль играет этот rewrite: клиентский код одинаков на обоих контурах и не
   * знает адреса API.
   *
   * Оговорка: через rewrite запрос идёт транзитом через Next, и API видит его
   * адрес, а не адрес посетителя. Для антинакрутки просмотров это значит, что
   * в разработке все анонимы — один посетитель. В проде запрос идёт в API
   * напрямую, а адрес разбирается из X-Forwarded-For (см. TRUST_PROXY_HOPS).
   */
  rewrites() {
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiBaseUrl}/api/:path*` }]);
  },

  // Пакет воркспейса собирается в CJS; Next должен прогнать его через свой конвейер.
  transpilePackages: ['@auction/shared'],

  env: {
    // Адрес API для SSR-запросов. Наружу, в браузер, не отдаётся: обращения к API
    // с сервера, чтобы внутренний адрес не светился в клиентском бандле.
    API_BASE_URL: process.env['API_BASE_URL'] ?? `http://127.0.0.1:${apiPort}`,

    /**
     * Где живёт WS-gateway. В браузер отдаётся сознательно (префикс
     * NEXT_PUBLIC_): сокет открывает клиент, и другого способа сообщить ему
     * адрес нет.
     *
     * В разработке задаётся только ПОРТ — имя хоста клиент берёт из адресной
     * строки. Кука сессии привязана к имени хоста и не смотрит на порт, а
     * `localhost` и `127.0.0.1` для неё разные хосты: жёсткий адрес приводил
     * бы к сокету без куки и к отказу на ставке при работающем таймере.
     *
     * За ingress'ом порт не при чём — там задаётся полный адрес WS_PUBLIC_URL.
     */
    NEXT_PUBLIC_WS_URL: process.env['WS_PUBLIC_URL'] ?? '',
    NEXT_PUBLIC_WS_PORT: process.env['GATEWAY_PORT'] ?? '3200',
  },
};

export default nextConfig;
