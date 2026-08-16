import {
  USER_ROLES,
  type CurrentUserView,
  type EgovLoginResult,
  type TokenPair,
} from '@auction/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { Env } from '../config/env.schema';
import type { EgovInitResult } from '../integrations/egov/egov.types';

import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './auth.types';
import { CurrentUser, Public, Roles } from './decorators';
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  cookieValue,
  setSessionCookies,
} from './session-cookies';
import { TokenService } from './token.service';

const DevLoginSchema = z
  .object({
    roles: z.array(z.enum(USER_ROLES)).min(1),
  })
  .strict();

const RefreshSchema = z
  .object({
    /** Необязателен: браузер присылает refresh кукой, которой не видит сам. */
    refreshToken: z.string().min(1).optional(),
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
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Выдать пару и заодно положить её в куки.
   *
   * Тело ответа сохраняется: мобильный клиент и e2e носят токен в заголовке.
   * Браузер тот же токен получает httpOnly-кукой и в JavaScript его не видит.
   */
  private issue(res: Response, pair: TokenPair): TokenPair {
    setSessionCookies(res, pair, {
      accessTtlMs: this.tokens.accessTtlMs,
      refreshTtlMs: this.tokens.refreshTtl,
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
    });
    return pair;
  }

  private drop(res: Response): void {
    clearSessionCookies(res, this.config.get('NODE_ENV', { infer: true }) === 'production');
  }

  /** Заглушка входа. В production ручка отвечает 404 — см. AuthService.devLogin. */
  @Public()
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вход-заглушка с произвольными ролями (только вне production)' })
  async devLogin(
    @Body() body: DevLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    return this.issue(res, await this.auth.devLogin(body.roles, metaOf(req)));
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
  async egovComplete(
    @Body() body: EgovCompleteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EgovLoginResult> {
    const result = await this.auth.egovComplete(body.sessionId, metaOf(req));
    if (result.status === 'COMPLETED') {
      this.issue(res, result.tokens);
    }
    return result;
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
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    // Браузер токена не знает — он лежит в куке, недоступной скриптам.
    const presented = body.refreshToken ?? cookieValue(req, REFRESH_COOKIE);
    if (presented === null) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN' });
    }
    return this.issue(res, await this.auth.refresh(presented, metaOf(req)));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Выход с текущего устройства' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user.sessionId);
    // Сессию гасим и в базе, и в браузере: оставленная кука — это ещё один
    // запрос с 401 при каждом переходе и вопрос «почему я не вышел».
    this.drop(res);
  }

  @Post('logout-everywhere')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выход со всех устройств' })
  async logoutEverywhere(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ revoked: number }> {
    const revoked = await this.auth.logoutEverywhere(user.id);
    this.drop(res);
    return { revoked };
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
