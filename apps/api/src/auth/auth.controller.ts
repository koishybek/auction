import { USER_ROLES, type CurrentUserView, type TokenPair } from '@auction/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './auth.types';
import { CurrentUser, Public, Roles } from './decorators';

const DevLoginSchema = z
  .object({
    roles: z.array(z.enum(USER_ROLES)).min(1),
  })
  .strict();

const RefreshSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

class DevLoginDto extends createZodDto(DevLoginSchema) {}
class RefreshDto extends createZodDto(RefreshSchema) {}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Заглушка входа. В production ручка отвечает 404 — см. AuthService.devLogin. */
  @Public()
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вход-заглушка (только вне production; настоящий eGov — T-012)' })
  devLogin(@Body() body: DevLoginDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.devLogin(body.roles, metaOf(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Обновить пару токенов (старый refresh гасится)' })
  refresh(@Body() body: RefreshDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken, metaOf(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Выход с текущего устройства' })
  logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.auth.logout(user.sessionId);
  }

  @Post('logout-everywhere')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выход со всех устройств' })
  async logoutEverywhere(@CurrentUser() user: AuthenticatedUser): Promise<{ revoked: number }> {
    return { revoked: await this.auth.logoutEverywhere(user.id) };
  }

  @Get('me')
  @ApiOperation({ summary: 'Текущий пользователь' })
  @ApiOkResponse({ description: 'Профиль без персональных данных' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<CurrentUserView> {
    return this.auth.currentUser(user);
  }

  /**
   * Существует ради проверки ролевого гварда в e2e: DoD T-011 требует показать,
   * что чужая роль получает 403, а не просто описать это словами.
   */
  @Roles('ADMIN')
  @Get('admin-only')
  @ApiOperation({ summary: 'Проба ролевого гварда: только ADMIN' })
  adminOnly(@CurrentUser() user: AuthenticatedUser): { ok: true; userId: string } {
    return { ok: true, userId: user.id };
  }
}

function metaOf(req: Request): { userAgent?: string | undefined; ip?: string | undefined } {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}
