import { LOT_STATUSES, LOT_TYPES, type LotListView, type LotView } from '@auction/shared';
import {
  Body,
  ConflictException,
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

/**
 * Витрина объекта: то, по чему человек выбирает, а не идентифицирует.
 *
 * Границы длин не косметика: заголовок и адрес рисуются в карточке каталога, и
 * поле без потолка ломает вёрстку списка на первом же продавце, который решит
 * записать туда абзац.
 */
const showcase = {
  title: z.string().trim().min(3).max(120).optional(),
  address: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(10).max(2000).optional(),
  /** Площадь в сотых квадратного метра: 62.4 м² приходят как 6240. */
  areaSqmX100: z.number().int().positive().max(10_000_000).optional(),
  mileageKm: z.number().int().nonnegative().max(3_000_000).optional(),
  buildYear: z.number().int().min(1800).max(2100).optional(),
};

const CreateLotSchema = z
  .object({
    type: z.enum(LOT_TYPES),
    cadastreOrVin,
    startPriceTenge: priceTenge,
    ...showcase,
  })
  .strict();

const UpdateLotSchema = z
  .object({
    cadastreOrVin: cadastreOrVin.optional(),
    startPriceTenge: priceTenge.optional(),
    ...showcase,
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

/**
 * Что нужно от запроса, чтобы узнать посетителя. `ip` даёт Express: с нулём
 * доверенных прокси — адрес сокета, за ingress — разобранный X-Forwarded-For
 * (см. TRUST_PROXY_HOPS).
 */
interface ViewRequest {
  readonly user?: AuthenticatedUser;
  readonly ip?: string;
  readonly headers: { readonly 'user-agent'?: string };
}

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

  /**
   * Отметка просмотра. Отдельная ручка, а не побочный эффект GET, по двум причинам.
   *
   * Первая — техническая и решающая: каталог рендерится на сервере, и карточку у
   * API запрашивает Next, а не браузер. Считая просмотры на GET, мы видели бы
   * адрес одного и того же SSR-процесса и посчитали бы за час ровно один заход
   * на всех посетителей.
   *
   * Вторая — GET обязан быть безопасным: обход поисковика или префетч ссылки
   * не должны менять состояние.
   */
  @Public()
  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отметить просмотр карточки (не чаще раза в час на посетителя)' })
  recordView(
    @Param('id', ParseUUIDPipe) lotId: string,
    @Req() req: ViewRequest,
  ): Promise<{ readonly counted: boolean }> {
    return this.lots.recordView(lotId, req.user ?? null, {
      userId: req.user?.id ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
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
    /**
     * PHASE_III через общую ручку не выставляется. Статус «идут торги» без
     * торговой сессии — это лот, на который нельзя поставить: цены, дедлайна и
     * seq не существует, а в каталоге он выглядит живым. Открывает торги
     * POST /admin/lots/:lotId/auction/start, который заводит и статус, и сессию.
     */
    if (body.to === 'PHASE_III') {
      throw new ConflictException({
        code: 'USE_AUCTION_START',
        message: 'Торги открываются через POST /api/admin/lots/{lotId}/auction/start',
      });
    }
    return this.lots.transition({ lotId, to: body.to, actor: 'ADMIN', actorId: user.id });
  }
}
