import type { IncomingHttpHeaders } from 'node:http';

/**
 * Адрес клиента за Cloudflare (T-050, NFR-05).
 *
 * Cloudflare кладёт настоящий адрес посетителя в `CF-Connecting-IP`. Считать
 * его самим по себе нельзя: заголовок дописывает кто угодно, кто достучался до
 * origin напрямую, — и антинакрутка просмотров с лимитом ставок начнут верить
 * атакующему на слово (FR-10, FR-15).
 *
 * Поэтому доверие включается флагом и ТОЛЬКО вместе с закрытым origin: пока
 * ingress принимает соединения не только от сетей Cloudflare, флаг обязан
 * оставаться выключенным. Зависимость записана здесь, а не только в
 * документации, потому что нарушить её можно одной переменной окружения.
 */

export const CLOUDFLARE_IP_HEADER = 'cf-connecting-ip';

/**
 * Взять адрес клиента.
 *
 * `fallback` — то, что посчитал Express по `trust proxy` (см. app.setup).
 * Заголовок Cloudflare побеждает только при включённом доверии.
 */
export function clientIpFrom(
  headers: IncomingHttpHeaders,
  fallback: string | null,
  trustCloudflare: boolean,
): string | null {
  if (!trustCloudflare) {
    return fallback;
  }

  const raw = headers[CLOUDFLARE_IP_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    // Запрос пришёл мимо Cloudflare. При закрытом origin такого быть не
    // должно, но падать из-за этого незачем — берём то, что видит сокет.
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}
