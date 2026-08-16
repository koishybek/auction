import type { DepositView } from '@auction/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, RequireEgovVerified, Roles } from '../auth/decorators';
import type { Env } from '../config/env.schema';

import { DepositPaymentsService } from './deposit-payments.service';
import { DepositsService } from './deposits.service';
import { RUNNER_UP_OPTIONS, RunnerUpService, type RunnerUpView } from './runner-up.service';

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

const RunnerUpChoiceSchema = z
  .object({
    /** А — задаток остаётся под дефолт победителя, Б — возврат (FR-14). */
    option: z.enum(RUNNER_UP_OPTIONS),
  })
  .strict();

class RunnerUpChoiceDto extends createZodDto(RunnerUpChoiceSchema) {}

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
    private readonly runnerUp: RunnerUpService,
    private readonly config: ConfigService<Env, true>,
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

  /**
   * Эмуляция оплаты счёта (только вне production).
   *
   * Тот же приём, что у `egov/dev-approve`: настоящего банка нет, и кто-то
   * должен сыграть плательщика — иначе путь задатка обрывается на выставленном
   * счёте и его нельзя ни проверить браузером, ни показать заказчику.
   */
  @Post('dev-pay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Банк-мок: эмулировать оплату задатка (только вне production)' })
  async devPay(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DepositView> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new NotFoundException('Ручка недоступна');
    }
    await this.payments.devPay({ lotId, userId: user.id });
    return this.deposits.view({ lotId, userId: user.id });
  }

  @Get('runner-up')
  @ApiOperation({ summary: 'Предложен ли мне выбор участника №2 (FR-14)' })
  runnerUpView(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RunnerUpView> {
    return this.runnerUp.view(lotId, user.id);
  }

  @Post('runner-up')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выбрать опцию: А — задаток под дефолт, Б — возврат' })
  chooseRunnerUp(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: RunnerUpChoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RunnerUpView> {
    return this.runnerUp.choose({ lotId, userId: user.id, option: body.option });
  }
}
