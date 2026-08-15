import type { DepositView } from '@auction/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, RequireEgovVerified, Roles } from '../auth/decorators';

import { DepositPaymentsService } from './deposit-payments.service';
import { DepositsService } from './deposits.service';

const HoldSchema = z
  .object({
    /**
     * Токен карты от эквайринга. Номер карты в наш контур не попадает: то, чего
     * у нас нет, невозможно у нас и украсть.
     */
    cardToken: z.string().min(8).max(256),
  })
  .strict();

class HoldDto extends createZodDto(HoldSchema) {}

/**
 * Задаток глазами участника (T-036, FR-12).
 *
 * Всё закрыто ролью INVESTOR и верификацией eGov: задаток — это деньги, а
 * деньги в системе двигает только подтверждённый человек (FR-03).
 */
@ApiTags('deposits')
@Controller('lots/:lotId/deposit')
@Roles('INVESTOR')
@RequireEgovVerified()
export class DepositsController {
  constructor(
    private readonly deposits: DepositsService,
    private readonly payments: DepositPaymentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Состояние моего задатка по лоту' })
  view(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DepositView> {
    return this.deposits.view({ lotId, userId: user.id });
  }

  @Post('invoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выставить счёт на задаток (IBAN спецсчёта, КБЕ, без НДС)' })
  invoice(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DepositView> {
    // Повторный вызов не плодит задатков — человек мог потерять ссылку.
    return this.payments.requestPayment({ lotId, userId: user.id });
  }

  @Post('hold')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Заблокировать задаток на карте (hold-эквайринг)' })
  hold(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: HoldDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DepositView> {
    return this.payments.holdCard({ lotId, userId: user.id, cardToken: body.cardToken });
  }
}
