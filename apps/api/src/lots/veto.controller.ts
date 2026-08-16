import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';

import { VetoService } from './veto.service';

/**
 * Решение продавца после торгов (T-045, FR-17).
 *
 * Две ручки, потому что это два разных решения, а не флаг: подтвердить сделку
 * или отклонить её правом ВЕТО. Отклонение закрывает объект для площадки на
 * пять месяцев — иначе торги превращаются в бесплатную оценку.
 */
@ApiTags('lots')
@Controller('lots/:lotId')
@Roles('SELLER')
export class VetoController {
  constructor(private readonly veto: VetoService) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Подтвердить сделку по итогам торгов' })
  confirm(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ status: 'CLOSED'; paymentId: string | null }> {
    return this.veto.confirm(lotId, user.id);
  }

  @Post('veto')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Право ВЕТО: отклонить сделку, объект уходит в Карантин на 5 месяцев' })
  reject(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ status: 'VETOED'; lockoutUntil: string; actDocumentId: string }> {
    return this.veto.veto(lotId, user.id);
  }
}
