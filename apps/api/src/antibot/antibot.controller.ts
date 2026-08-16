import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';

import { AntibotService } from './antibot.service';

const SolveSchema = z
  .object({
    /** Токен виджета капчи. Проверяет его провайдер, не мы. */
    token: z.string().min(1).max(4096),
    /** Сессия сокета, которой выставлено требование. */
    sessionId: z.string().min(1).max(128),
  })
  .strict();

class SolveDto extends createZodDto(SolveSchema) {}

/**
 * Снятие требования капчи (T-049, FR-11).
 *
 * По REST, а не по сокету: проверка токена ходит к внешнему провайдеру и
 * занимает сотни миллисекунд — такому не место в канале, который обязан
 * доставлять ставки за миллисекунды.
 */
@ApiTags('auction')
@Controller('auction/captcha')
export class AntibotController {
  private readonly logger = new Logger(AntibotController.name);

  constructor(private readonly antibot: AntibotService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Предъявить решённую капчу и вернуть себе право ставить' })
  async solve(
    @Body() body: SolveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const solved = await this.antibot.solve({
      sessionId: body.sessionId,
      token: body.token,
      remoteIp: req.ip ?? null,
    });
    if (!solved) {
      // Отказ, а не 200 с флагом: непринятая капча — это отказ в праве
      // ставить, и клиент обязан показать виджет заново.
      throw new ForbiddenException({ code: 'CAPTCHA_REJECTED' });
    }
    // Снятие санкции — событие, которое хочется видеть в логе рядом с её
    // выставлением: иначе непонятно, чем закончилась эскалация.
    this.logger.log(`Сессия ${body.sessionId} пользователя ${user.id}: капча принята`);
    return { ok: true };
  }
}
