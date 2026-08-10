import type { UserRole } from '@auction/shared';
import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser } from './auth.types';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const REQUIRE_EGOV_VERIFIED_KEY = 'auth:egov-verified';

/**
 * Открытая ручка.
 *
 * Гвард включён глобально, поэтому по умолчанию всё закрыто. Забыть повесить
 * защиту невозможно — можно только явно снять её этим декоратором, и такое
 * место видно в диффе.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Доступ только перечисленным ролям. Достаточно одной совпавшей. */
export const Roles = (...roles: readonly UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Только для верифицированных через eGov. Вешается на всё, что касается денег:
 * задаток, ставки, реквизиты (FR-03).
 */
export const RequireEgovVerified = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_EGOV_VERIFIED_KEY, true);

/** Текущий пользователь из access-токена. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) {
      // Значит ручку пометили @Public, но пытаются достать пользователя.
      throw new Error('CurrentUser запрошен на ручке без авторизации');
    }
    return request.user;
  },
);
