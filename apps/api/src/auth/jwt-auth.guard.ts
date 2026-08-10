import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import { AUTH_ERROR, type AuthenticatedUser } from './auth.types';
import { IS_PUBLIC_KEY } from './decorators';
import { TokenService } from './token.service';

/**
 * Проверка access-токена. Включён глобально, поэтому по умолчанию закрыто всё,
 * и открыть ручку можно только явным @Public.
 *
 * Гвард ходит в БД на каждый запрос — это осознанная цена. Отозвать выданный JWT
 * невозможно, а T-014 требует, чтобы заблокированный админом пользователь
 * переставал проходить проверку немедленно, а не через 15 минут. Один индексный
 * запрос на REST-обращение допустим: нагрузка в 50 000 подключений приходится
 * на WebSocket, где авторизация происходит один раз при входе в комнату, а не
 * на каждую ставку. Станет узким местом — переедет в кэш Redis с коротким TTL.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = extractBearer(request.headers.authorization);

    if (isPublic === true) {
      // Публичная ручка, но токен прислали — распознаём пользователя по мере сил.
      // Нужно публичной карточке лота: владелец видит свой черновик, аноним — нет.
      // Любая проблема с токеном здесь НЕ ошибка: просто остаёмся анонимом.
      if (token !== null) {
        await this.tryAttachUser(request, token);
      }
      return true;
    }

    if (token === null) {
      throw new UnauthorizedException({ code: AUTH_ERROR.INVALID_TOKEN });
    }

    let payload;
    try {
      payload = this.tokens.verifyAccess(token);
    } catch {
      // Причину наружу не отдаём: просрочен токен или подделан — не дело клиента.
      throw new UnauthorizedException({ code: AUTH_ERROR.INVALID_TOKEN });
    }

    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sid },
      include: { user: { select: { status: true, roles: true, egovVerifiedAt: true } } },
    });

    if (!session) {
      throw new UnauthorizedException({ code: AUTH_ERROR.SESSION_REVOKED });
    }
    if (session.revokedAt !== null || session.expiresAt <= new Date(this.time.wallClockMs())) {
      throw new UnauthorizedException({ code: AUTH_ERROR.SESSION_REVOKED });
    }
    if (session.user.status === 'BLOCKED') {
      throw new ForbiddenException({ code: AUTH_ERROR.USER_BLOCKED });
    }

    // Роли берём из БД, а не из токена: админ мог их поменять после выдачи,
    // и токен об этом ничего не знает.
    request.user = {
      id: session.userId,
      roles: session.user.roles,
      sessionId: session.id,
      egovVerified: session.user.egovVerifiedAt !== null,
    };
    return true;
  }

  /** Аутентификация без права на ошибку: не вышло — остаёмся анонимом. */
  private async tryAttachUser(request: { user?: AuthenticatedUser }, token: string): Promise<void> {
    try {
      const payload = this.tokens.verifyAccess(token);
      const session = await this.prisma.authSession.findUnique({
        where: { id: payload.sid },
        include: { user: { select: { status: true, roles: true, egovVerifiedAt: true } } },
      });
      if (
        !session ||
        session.revokedAt !== null ||
        session.expiresAt <= new Date(this.time.wallClockMs()) ||
        session.user.status === 'BLOCKED'
      ) {
        return;
      }
      request.user = {
        id: session.userId,
        roles: session.user.roles,
        sessionId: session.id,
        egovVerified: session.user.egovVerifiedAt !== null,
      };
    } catch {
      // Кривой токен на публичной ручке — не ошибка.
    }
  }
}

function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') return null;
  return value;
}
