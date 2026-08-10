import type { UserRole } from '@auction/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AUTH_ERROR, type AuthenticatedUser } from './auth.types';
import { ROLES_KEY } from './decorators';

/**
 * Проверка роли. Идёт строго после JwtAuthGuard, иначе проверять нечего.
 *
 * Здесь только грубый доступ «пускать ли роль в эту ручку». Владение конкретным
 * ресурсом — «этот лот действительно мой» — проверяется в сервисах: гвард про
 * данные ничего не знает и знать не должен.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException({ code: AUTH_ERROR.FORBIDDEN_ROLE });
    }

    if (!required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException({ code: AUTH_ERROR.FORBIDDEN_ROLE });
    }
    return true;
  }
}
