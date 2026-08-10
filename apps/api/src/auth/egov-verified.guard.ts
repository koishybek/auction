import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AUTH_ERROR, type AuthenticatedUser } from './auth.types';
import { REQUIRE_EGOV_VERIFIED_KEY } from './decorators';

/**
 * Допуск только верифицированным через eGov.
 *
 * Правило продукта (§2.1 ТЗ, FR-03): деньги — задаток, ставки — доступны только
 * подтверждённой личности. Гвард глобальный, включается декоратором
 * @RequireEgovVerified() на ручке или контроллере; первым потребителем станет
 * внесение задатка (T-034/T-036).
 *
 * Статус читается из request.user, куда его положил JwtAuthGuard из БД, —
 * отдельного запроса нет, отставания от базы тоже.
 */
@Injectable()
export class EgovVerifiedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_EGOV_VERIFIED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (request.user?.egovVerified !== true) {
      throw new ForbiddenException({ code: AUTH_ERROR.EGOV_NOT_VERIFIED });
    }
    return true;
  }
}
