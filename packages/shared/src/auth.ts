/**
 * Контракт авторизации между api и web.
 *
 * Роли берутся из раздела 4 ТЗ: инвестор (покупатель), продавец, партнёр-риелтор.
 * ADMIN добавлен как «вне ТЗ» по ОВ-8 — без админки систему не эксплуатировать.
 */

export const USER_ROLES = ['INVESTOR', 'SELLER', 'PARTNER', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Полезная нагрузка access-токена. Ничего лишнего: токен читается кем угодно. */
export interface AccessTokenPayload {
  /** id пользователя */
  readonly sub: string;
  readonly roles: readonly UserRole[];
  /** id сессии — по нему access привязан к конкретному входу. */
  readonly sid: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Через сколько секунд истекает access. Клиенту, чтобы обновиться заранее. */
  readonly expiresInSec: number;
}

/** Профиль текущего пользователя. ПДн здесь не появляются — только статусы. */
export interface CurrentUserView {
  readonly id: string;
  readonly roles: readonly UserRole[];
  readonly status: 'ACTIVE' | 'BLOCKED';
  readonly egovVerified: boolean;
}

/** Ответ на завершение eGov-флоу: либо ещё ждём подтверждения, либо вход состоялся. */
export type EgovLoginResult =
  { readonly status: 'PENDING' } | { readonly status: 'COMPLETED'; readonly tokens: TokenPair };
