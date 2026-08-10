import type { CurrentUserView, TokenPair, UserRole } from '@auction/shared';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import { AUTH_ERROR, type AuthenticatedUser } from './auth.types';
import { TokenService } from './token.service';

interface SessionMeta {
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly isProduction: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly time: TimeService,
    config: ConfigService<Env, true>,
  ) {
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * Вход-заглушка вместо eGov Digital ID.
   *
   * Настоящая авторизация приходит в T-012 (адаптер eGov). До тех пор нужен
   * способ получить токен, иначе разработку и e2e нечем двигать.
   *
   * В production недоступен физически, а не по забывчивости: такая ручка на бою
   * означает вход под любой ролью для кого угодно.
   */
  async devLogin(roles: readonly UserRole[], meta: SessionMeta): Promise<TokenPair> {
    if (this.isProduction) {
      this.logger.error('Попытка вызвать dev-login в production');
      throw new NotFoundException('Ручка недоступна');
    }
    if (roles.length === 0) {
      throw new ForbiddenException('Нужна хотя бы одна роль');
    }

    const user = await this.prisma.user.create({ data: { roles: [...roles] } });
    return this.issueTokens(user.id, roles, crypto.randomUUID(), meta);
  }

  /**
   * Обновление пары токенов с ротацией.
   *
   * Старый refresh гасится, выдаётся новый в том же семействе. Если предъявлен
   * уже потраченный токен — значит его кто-то украл и использует параллельно
   * с законным владельцем. В этом случае гасится ВСЁ семейство: лучше заставить
   * человека войти заново, чем оставить вору живую сессию.
   */
  async refresh(refreshToken: string, meta: SessionMeta): Promise<TokenPair> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException({ code: AUTH_ERROR.INVALID_TOKEN });
    }

    if (session.rotatedAt !== null) {
      await this.revokeFamily(session.familyId);
      this.logger.warn(
        { userId: session.userId, familyId: session.familyId },
        'Повторное использование refresh-токена: семейство сессий погашено',
      );
      throw new UnauthorizedException({ code: AUTH_ERROR.REFRESH_REUSED });
    }

    const now = new Date(this.time.wallClockMs());
    if (session.revokedAt !== null || session.expiresAt <= now) {
      throw new UnauthorizedException({ code: AUTH_ERROR.SESSION_REVOKED });
    }
    if (session.user.status === 'BLOCKED') {
      throw new ForbiddenException({ code: AUTH_ERROR.USER_BLOCKED });
    }

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { rotatedAt: now },
    });

    return this.issueTokens(session.userId, session.user.roles, session.familyId, meta);
  }

  /** Выход с текущего устройства. Остальные сессии пользователя продолжают жить. */
  async logout(sessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(this.time.wallClockMs()) },
    });
  }

  /** Выход со всех устройств: смена пароля, подозрение на компрометацию, блокировка. */
  async logoutEverywhere(userId: string): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(this.time.wallClockMs()) },
    });
    return result.count;
  }

  async currentUser(user: AuthenticatedUser): Promise<CurrentUserView> {
    const found = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return {
      id: found.id,
      roles: found.roles,
      status: found.status,
      egovVerified: found.egovVerifiedAt !== null,
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(this.time.wallClockMs()) },
    });
  }

  private async issueTokens(
    userId: string,
    roles: readonly UserRole[],
    familyId: string,
    meta: SessionMeta,
  ): Promise<TokenPair> {
    const refreshToken = this.tokens.generateRefreshToken();
    const now = new Date(this.time.wallClockMs());

    const session = await this.prisma.authSession.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        expiresAt: this.tokens.refreshExpiresAt(now),
        ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent.slice(0, 256) }),
        ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      },
    });

    const accessToken = this.tokens.signAccess({
      sub: userId,
      roles,
      sid: session.id,
    });

    return { accessToken, refreshToken, expiresInSec: this.tokens.accessTtlSec() };
  }
}
