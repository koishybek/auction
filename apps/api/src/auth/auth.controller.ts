import {
  USER_ROLES,
  type CurrentUserView,
  type EgovLoginResult,
  type TokenPair,
} from '@auction/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { EgovInitResult } from '../integrations/egov/egov.types';

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

const EgovCompleteSchema = z
  .object({
    sessionId: z.uuid(),
  })
  .strict();

/**
 * Тело dev-approve. ИИН — 12 цифр, как настоящий: мок должен гонять те же
 * данные, что боевой eGov, иначе тесты пройдут на том, чего не бывает.
 */
const EgovDevApproveSchema = z
  .object({
    sessionId: z.uuid(),
    iin: z.string().regex(/^\d{12}$/, 'ИИН — ровно 12 цифр'),
    fio: z.string().min(1).max(300),
    biometricConfirmed: z.boolean().default(false),
    /** true — эмулировать отказ гражданина вместо подтверждения. */
    deny: z.boolean().default(false),
  })
  .strict();

class DevLoginDto extends createZodDto(DevLoginSchema) {}
class RefreshDto extends createZodDto(RefreshSchema) {}
class EgovCompleteDto extends createZodDto(EgovCompleteSchema) {}
class EgovDevApproveDto extends createZodDto(EgovDevApproveSchema) {}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Заглушка входа. В production ручка отвечает 404 — см. AuthService.devLogin. */
  @Public()
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вход-заглушка с произвольными ролями (только вне production)' })
  devLogin(@Body() body: DevLoginDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.devLogin(body.roles, metaOf(req));
  }

  /** Шаг 1 eGov-флоу: получить QR. План задаёт этот контракт в разделе 7. */
  @Public()
  @Post('egov/init')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'eGov: начать QR-флоу' })
  egovInit(): Promise<EgovInitResult> {
    return this.auth.egovInit();
  }

  /**
   * Шаг 2: обмен подтверждённой сессии на токены. Клиент опрашивает ручку,
   * пока статус PENDING. POST, а не GET из плана: обмен мутирует состояние,
   * а GET с побочными эффектами кэшируется и ретраится прокси.
   */
  @Public()
  @Post('egov/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'eGov: завершить флоу (опрашивать при PENDING)' })
  egovComplete(@Body() body: EgovCompleteDto, @Req() req: Request): Promise<EgovLoginResult> {
    return this.auth.egovComplete(body.sessionId, metaOf(req));
  }

  /**
   * Эмуляция подтверждения в eGov Mobile. Существует потому, что настоящего
   * eGov нет (R-1): кто-то должен сыграть роль гражданина со смартфоном.
   * В production — 404, как и dev-login.
   */
  @Public()
  @Post('egov/dev-approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'eGov-мок: эмулировать решение гражданина (только вне production)' })
  egovDevApprove(@Body() body: EgovDevApproveDto): { ok: boolean } {
    return { ok: this.auth.egovDevDecide(body) };
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
