import type { PartnerLeadView, PartnerLeadsView, RefBonusesView } from '@auction/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, RequireEgovVerified, Roles } from '../auth/decorators';

import { LeadsService } from './leads.service';
import { RefBonusService } from './ref-bonus.service';

const RegisterLeadSchema = z
  .object({
    /** ИИН собственника — 12 цифр, как в eGov: мок и прод гоняют одни данные. */
    ownerIin: z.string().regex(/^\d{12}$/, 'ИИН — ровно 12 цифр'),
    ownerPhone: z.string().min(10).max(20),
    /** Кадастровый номер или VIN — то, чем объект опознаётся однозначно. */
    cadastreOrVin: z.string().min(5).max(64),
  })
  .strict();

class RegisterLeadDto extends createZodDto(RegisterLeadSchema) {}

/**
 * Кабинет партнёра (T-042, FR-18).
 *
 * Верификация обязательна: закрепление лида — это будущие деньги (Ref-Bonus
 * 2 %), и получать их может только подтверждённый человек (FR-03).
 */
@ApiTags('partners')
@Controller('partner')
@Roles('PARTNER')
@RequireEgovVerified()
export class PartnersController {
  constructor(
    private readonly leads: LeadsService,
    private readonly bonuses: RefBonusService,
  ) {}

  @Get('leads')
  @ApiOperation({ summary: 'Мои лиды и сроки закрепления' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<PartnerLeadsView> {
    return this.leads.list(user.id);
  }

  @Get('ref-bonus')
  @ApiOperation({ summary: 'Мои 2 %: прогноз по идущим торгам и начисленное' })
  refBonus(@CurrentUser() user: AuthenticatedUser): Promise<RefBonusesView> {
    return this.bonuses.list(user.id);
  }

  @Post('leads')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Зарегистрировать лид и закрепить объект на 90 дней' })
  register(
    @Body() body: RegisterLeadDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PartnerLeadView> {
    return this.leads.register({
      partnerId: user.id,
      cadastreOrVin: body.cadastreOrVin,
      ownerIin: body.ownerIin,
      ownerPhone: body.ownerPhone,
    });
  }
}
