import type { AuctionStateView, BidDenyCode, BidUpdatedEvent } from '@auction/shared';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';

import { AuctionService } from './auction.service';
import { BidPlacementService } from './bid-placement.service';

/** Сколько последних ставок отдавать. Потолок — чтобы лента не стала выгрузкой всей сессии. */
const BidHistorySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

class BidHistoryDto extends createZodDto(BidHistorySchema) {}

@ApiTags('auction')
@Controller('lots/:lotId/auction')
export class AuctionController {
  constructor(
    private readonly auction: AuctionService,
    private readonly placement: BidPlacementService,
  ) {}

  /**
   * Снимок торгов. Публичный: цену и остаток таймера видно всем, включая
   * незарегистрированных — это витрина, а не участие. Права проверяются на
   * ставке, а не на просмотре.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Состояние торгов: цена, номер ставки, остаток таймера' })
  snapshot(@Param('lotId', ParseUUIDPipe) lotId: string): Promise<AuctionStateView> {
    return this.auction.snapshot(lotId);
  }

  /**
   * Лента ставок. Публичная: ход торгов виден всем, но только под
   * псевдонимами — реальных участников в ней нет (FR-09).
   */
  @Public()
  @Get('bids')
  @ApiOperation({ summary: 'Последние ставки лота в формате bid_updated (ТЗ §2.1)' })
  history(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Query() query: BidHistoryDto,
  ): Promise<BidUpdatedEvent[]> {
    return this.auction.history(lotId, query.limit);
  }

  /**
   * Вправе ли я ставить по этому лоту (FR-16).
   *
   * Ответ даёт та же проверка, что стоит на пути ставки, — не её копия.
   * Интерфейсу нужно знать причину заранее, чтобы не предлагать кнопку,
   * которую сервер всё равно отклонит; но сама проверка остаётся на сервере,
   * и спрятанная кнопка ничего не разрешает.
   */
  @Get('eligibility')
  @ApiOperation({ summary: 'Могу ли я ставить по этому лоту и почему нет' })
  async eligibility(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ allowed: boolean; code: BidDenyCode | null }> {
    const denied = await this.placement.checkEligibility(user.id, lotId);
    return { allowed: denied === null, code: denied };
  }
}

/**
 * Открытие торгов — административное действие, поэтому отдельный контроллер
 * под /admin (как и смена статусов лота).
 */
@ApiTags('admin')
@Roles('ADMIN')
@Controller('admin/lots/:lotId/auction')
export class AdminAuctionController {
  constructor(private readonly auction: AuctionService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Открыть торги: PHASE_II → PHASE_III и состояние сессии' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('lotId', ParseUUIDPipe) lotId: string,
  ): Promise<AuctionStateView> {
    return this.auction.start(lotId, user.id);
  }
}
