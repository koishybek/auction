import type { MyProfileView } from '@auction/shared';
import { Injectable } from '@nestjs/common';

import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import { PrismaService } from '../prisma/prisma.service';

/** «900101300123» → «900101******». Дата рождения видна владельцу, остальное скрыто. */
export function maskIin(iin: string): string {
  return iin.length === 12 ? `${iin.slice(0, 6)}******` : '*'.repeat(iin.length);
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * Профиль владельца. Расшифровка здесь легальна: человек смотрит собственные
   * данные. Наружу уходит явный DTO — сущность Prisma с *_enc-колонками не
   * покидает сервис.
   */
  async myProfile(userId: string): Promise<MyProfileView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    return {
      id: user.id,
      roles: user.roles,
      status: user.status,
      egovVerified: user.egovVerifiedAt !== null,
      verifiedAt: user.egovVerifiedAt?.toISOString() ?? null,
      fio: user.fioEnc ? this.pii.decrypt(user.fioEnc, 'users.fio') : null,
      iinMasked: user.iinEnc ? maskIin(this.pii.decrypt(user.iinEnc, 'users.iin')) : null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
