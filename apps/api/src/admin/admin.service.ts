import { Injectable, NotFoundException } from '@nestjs/common';

import { AuthService } from '../auth/auth.service';
import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import { maskIin } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

export interface AdminUserView {
  readonly id: string;
  readonly roles: readonly string[];
  readonly status: 'ACTIVE' | 'BLOCKED';
  readonly egovVerified: boolean;
  readonly fio: string | null;
  readonly iinMasked: string | null;
  readonly createdAt: string;
  readonly sessionsActive: number;
}

export interface AdminUserListView {
  readonly items: readonly AdminUserView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCryptoService,
    private readonly auth: AuthService,
    private readonly time: TimeService,
  ) {}

  /**
   * Список пользователей для модерации.
   *
   * ФИО расшифровывается — админу оно нужно, чтобы понимать, кого он блокирует.
   * ИИН — только маской даже для админа: полное значение не нужно для модерации,
   * а каждая точка показа полного ИИН — это точка утечки. Каждый просмотр
   * списка фиксируется в audit_log: доступ к ПДн должен оставлять след.
   */
  async listUsers(input: {
    page: number;
    pageSize: number;
    status?: 'ACTIVE' | 'BLOCKED' | undefined;
    actorId: string;
  }): Promise<AdminUserListView> {
    const where = input.status === undefined ? {} : { status: input.status };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        include: { _count: { select: { authSessions: { where: { revokedAt: null } } } } },
      }),
      this.prisma.user.count({ where }),
    ]);

    await this.prisma.auditLog.create({
      data: {
        actor: input.actorId,
        action: 'admin.users.list',
        entity: 'users',
        payloadJson: { page: input.page, pageSize: input.pageSize, status: input.status ?? null },
        serverTs: new Date(this.time.wallClockMs()),
      },
    });

    return {
      items: users.map((user) => ({
        id: user.id,
        roles: user.roles,
        status: user.status,
        egovVerified: user.egovVerifiedAt !== null,
        fio: user.fioEnc ? this.pii.decrypt(user.fioEnc, 'users.fio') : null,
        iinMasked: user.iinEnc ? maskIin(this.pii.decrypt(user.iinEnc, 'users.iin')) : null,
        createdAt: user.createdAt.toISOString(),
        sessionsActive: user._count.authSessions,
      })),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  /**
   * Блокировка. Вместе со статусом гасятся ВСЕ сессии: JwtAuthGuard и так
   * отбил бы заблокированного по статусу, но живые refresh-токены при этом
   * продолжали бы существовать — а мёртвый вход должен быть мёртв целиком.
   */
  async setUserStatus(input: {
    userId: string;
    status: 'ACTIVE' | 'BLOCKED';
    actorId: string;
    reason: string;
  }): Promise<{ id: string; status: 'ACTIVE' | 'BLOCKED'; sessionsRevoked: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    }

    await this.prisma.user.update({
      where: { id: input.userId },
      data: { status: input.status },
    });

    const sessionsRevoked =
      input.status === 'BLOCKED' ? await this.auth.logoutEverywhere(input.userId) : 0;

    await this.prisma.auditLog.create({
      data: {
        actor: input.actorId,
        action: input.status === 'BLOCKED' ? 'admin.user.block' : 'admin.user.unblock',
        entity: 'users',
        entityId: input.userId,
        payloadJson: { reason: input.reason, sessionsRevoked },
        serverTs: new Date(this.time.wallClockMs()),
      },
    });

    return { id: input.userId, status: input.status, sessionsRevoked };
  }
}
