import type { UserRole } from '@auction/shared';

/** То, что гвард кладёт в request после проверки access-токена. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly roles: readonly UserRole[];
  /** id сессии: по нему можно погасить конкретный вход, не трогая остальные. */
  readonly sessionId: string;
}

/** Коды отказов авторизации. Клиент различает их, чтобы понять, что делать дальше. */
export const AUTH_ERROR = {
  /** Токена нет или он не разбирается. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** Пользователь заблокирован админом. Обновление токена не поможет. */
  USER_BLOCKED: 'USER_BLOCKED',
  /** Сессия отозвана или истекла — нужен повторный вход. */
  SESSION_REVOKED: 'SESSION_REVOKED',
  /** Роль не подходит. Повторный вход не поможет. */
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  /** Предъявлен уже использованный refresh — признак кражи, семейство погашено. */
  REFRESH_REUSED: 'REFRESH_REUSED',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];
