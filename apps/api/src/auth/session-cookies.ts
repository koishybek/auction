import type { TokenPair } from '@auction/shared';
import type { Request, Response } from 'express';

/**
 * Транспорт сессии для браузера (T-011, нужен фронту Фазы 5).
 *
 * Мобильные и служебные клиенты продолжают носить токен в заголовке
 * `Authorization`. Браузеру так нельзя: токен, доступный JavaScript, доступен
 * и любому чужому скрипту, попавшему на страницу, — а вместе с ним доступны
 * задаток и ставки. Поэтому в вебе токен живёт в httpOnly-куке, которой скрипт
 * не видит вовсе.
 *
 * Плата за куку — CSRF: браузер шлёт её сам, и чужая страница может отправить
 * запрос от имени вошедшего. Закрывается `SameSite=Strict`: кука не уходит ни
 * с одним межсайтовым запросом. Отдельного CSRF-токена поэтому нет — второй
 * механизм от той же угрозы, который нужно не забыть проверить.
 */

export const ACCESS_COOKIE = 'auction_at';
export const REFRESH_COOKIE = 'auction_rt';

/**
 * Refresh-кука уходит только в ручки авторизации.
 *
 * Долгоживущий токен не должен ездить с каждым запросом за каталогом: чем реже
 * он покидает браузер, тем меньше мест, где его можно потерять.
 */
const REFRESH_PATH = '/api/auth';

interface CookieOptions {
  readonly httpOnly: true;
  readonly sameSite: 'strict';
  readonly secure: boolean;
  readonly path: string;
  readonly maxAge: number;
}

function options(path: string, maxAgeMs: number, secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure, path, maxAge: maxAgeMs };
}

/** Положить пару в куки. `secure` выключается только вне production: localhost без TLS. */
export function setSessionCookies(
  res: Response,
  tokens: TokenPair,
  config: { accessTtlMs: number; refreshTtlMs: number; secure: boolean },
): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, options('/', config.accessTtlMs, config.secure));
  res.cookie(
    REFRESH_COOKIE,
    tokens.refreshToken,
    options(REFRESH_PATH, config.refreshTtlMs, config.secure),
  );
}

/** Снять куки. Атрибуты обязаны совпадать с выданными, иначе браузер не удалит. */
export function clearSessionCookies(res: Response, secure: boolean): void {
  res.clearCookie(ACCESS_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: REFRESH_PATH,
  });
}

/**
 * Достать значение куки из заголовка.
 *
 * Разбор руками, без cookie-parser: нам нужны ровно два известных имени, а
 * лишняя зависимость в цепочке авторизации — это лишний код, которому мы
 * доверяем проверку доступа к деньгам.
 */
export function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}
