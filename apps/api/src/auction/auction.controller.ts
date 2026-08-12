import type { AuctionStateView } from '@auction/shared';
import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';

import { AuctionService } from './auction.service';

@ApiTags('auction')
@Controller('lots/:lotId/auction')
export class AuctionController {
  constructor(private readonly auction: AuctionService) {}

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
