import { LOT_STATUSES, LOT_TYPES, type LotListView, type LotView } from '@auction/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';

import { LotsService } from './lots.service';

/**
 * Кадастровый номер или VIN. Формат намеренно нестрогий (буквы/цифры/дефис/двоеточие):
 * реальные форматы РК разнообразны, жёсткая валидация появится вместе с
 * реестровым адаптером (T-019), которому этот номер и уходит.
 */
const cadastreOrVin = z
  .string()
  .trim()
  .min(5)
  .max(64)
  .regex(/^[0-9A-Za-zА-Яа-я:-]+$/, 'Только буквы, цифры, дефис и двоеточие');

/**
 * Цена в целых тенге. Верхняя граница — 1 трлн ₸: защита от опечатки на
 * порядки, а не бизнес-правило.
 */
const priceTenge = z
  .number()
  .int()
  .positive()
  .max(1_000_000_000_000, 'Цена выше 1 трлн ₸ — похоже на опечатку');

const CreateLotSchema = z
  .object({
    type: z.enum(LOT_TYPES),
    cadastreOrVin,
    startPriceTenge: priceTenge,
  })
  .strict();

const UpdateLotSchema = z
  .object({
    cadastreOrVin: cadastreOrVin.optional(),
    startPriceTenge: priceTenge.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Пустая правка' });

const ListLotsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    type: z.enum(LOT_TYPES).optional(),
    status: z.enum(LOT_STATUSES).optional(),
  })
  .strict();

const AdminTransitionSchema = z
  .object({
    to: z.enum(LOT_STATUSES),
    reason: z.string().min(3).max(500),
  })
  .strict();

class CreateLotDto extends createZodDto(CreateLotSchema) {}
class UpdateLotDto extends createZodDto(UpdateLotSchema) {}
class ListLotsDto extends createZodDto(ListLotsSchema) {}
class AdminTransitionDto extends createZodDto(AdminTransitionSchema) {}

@ApiTags('lots')
@Controller('lots')
export class LotsController {
  constructor(private readonly lots: LotsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Публичный каталог лотов (фазы I–III и завершённые)' })
  list(@Query() query: ListLotsDto): Promise<LotListView> {
    return this.lots.listPublic(query);
  }

  @Roles('SELLER')
  @Get('my')
  @ApiOperation({ summary: 'Мои лоты (продавец): все статусы, включая черновики' })
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLotsDto,
  ): Promise<LotListView> {
    return this.lots.listMine(user.id, query.page, query.pageSize);
  }

  /**
   * Публичная карточка. @Public + ручной разбор пользователя: аноним видит
   * только публичные статусы, владелец и админ — свои черновики. Гвард сюда
   * не подходит — авторизация здесь опциональна.
   */
  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Карточка лота (черновики видны только владельцу и админу)' })
  getById(
    @Param('id', ParseUUIDPipe) lotId: string,
    @Req() req: { user?: AuthenticatedUser },
  ): Promise<LotView> {
    return this.lots.getById(lotId, req.user ?? null);
  }

  @Roles('SELLER')
  @Post()
  @ApiOperation({ summary: 'Создать черновик лота' })
  @ApiOkResponse({ description: 'Черновик создан, цена сохранена в тиынах' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateLotDto): Promise<LotView> {
    return this.lots.createDraft({ sellerId: user.id, ...body });
  }

  @Roles('SELLER')
  @Patch(':id')
  @ApiOperation({ summary: 'Править черновик (после модерации лот заморожен)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) lotId: string,
    @Body() body: UpdateLotDto,
  ): Promise<LotView> {
    return this.lots.updateDraft({ lotId, sellerId: user.id, ...body });
  }

  @Roles('SELLER')
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Отправить черновик на модерацию (проверка КИСИП/ЕРД; ограничение = 409)',
  })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) lotId: string,
  ): Promise<LotView> {
    return this.lots.submit(lotId, user);
  }
}

/** Переходы статусов админом — отдельный контроллер под /admin (план, раздел 7). */
@ApiTags('admin')
@Roles('ADMIN')
@Controller('admin/lots')
export class AdminLotsController {
  constructor(private readonly lots: LotsService) {}

  @Patch(':id/status')
  @ApiOperation({ summary: 'Сменить статус лота (по таблице переходов; иначе 409)' })
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) lotId: string,
    @Body() body: AdminTransitionDto,
  ): Promise<LotView> {
    return this.lots.transition({ lotId, to: body.to, actor: 'ADMIN', actorId: user.id });
  }
}
