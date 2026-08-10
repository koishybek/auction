import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';

import { OpenHouseService, type OpenHouseSlotView } from './open-house.service';

const CreateSlotsSchema = z
  .object({
    /** ISO-времена слотов. До 20 за раз — больше руками не назначают. */
    slotsAt: z.array(z.iso.datetime()).min(1).max(20),
  })
  .strict();

class CreateSlotsDto extends createZodDto(CreateSlotsSchema) {}

@ApiTags('lots')
@Controller('lots/:lotId/open-house')
export class OpenHouseController {
  constructor(private readonly openHouse: OpenHouseService) {}

  /** График виден всем: расписание показов — публичная часть карточки лота. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'График Open House по лоту' })
  list(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Req() req: { user?: AuthenticatedUser },
  ): Promise<readonly OpenHouseSlotView[]> {
    return this.openHouse.listSlots(lotId, req.user ?? null);
  }

  @Roles('SELLER')
  @Post('slots')
  @ApiOperation({ summary: 'Назначить слоты показов (окно 5 дней, только владелец)' })
  @ApiOkResponse({ description: 'Повтор того же расписания не создаёт дублей' })
  createSlots(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: CreateSlotsDto,
    @CurrentUser() seller: AuthenticatedUser,
  ): Promise<readonly OpenHouseSlotView[]> {
    return this.openHouse.createSlots({ lotId, seller, slotsAt: body.slotsAt });
  }

  @Roles('INVESTOR')
  @Post('slots/:slotId/book')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Записаться на показ (двойная запись невозможна)' })
  book(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<OpenHouseSlotView> {
    return this.openHouse.book(slotId, viewer);
  }

  @Roles('INVESTOR')
  @Delete('slots/:slotId/book')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Отменить свою запись на показ' })
  cancel(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<void> {
    return this.openHouse.cancel(slotId, viewer);
  }
}
