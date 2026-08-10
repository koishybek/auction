import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { EgovModule } from '../integrations/egov/egov.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';

/**
 * Гварды регистрируются глобально и именно в этом порядке: сначала проверяется
 * токен, потом роль — иначе RolesGuard проверял бы роли у неизвестно кого.
 *
 * Глобально, а не на контроллерах: по умолчанию всё закрыто, и открыть ручку
 * можно только явным @Public. Обратный порядок (по умолчанию открыто) означает,
 * что однажды кто-то забудет декоратор и выставит наружу лишнее.
 */
@Module({
  imports: [JwtModule.register({}), EgovModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
