import type { SellerDashboardView } from '@auction/shared';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';

import { SellerService } from './seller.service';

/**
 * Кабинет продавца (T-041, FR-15/FR-16).
 *
 * Владение проверяется не гвардом, а выборкой: лоты берутся по `sellerId`
 * текущего пользователя, и чужой лот сюда не попадает в принципе — забыть
 * фильтр невозможно, потому что другого источника у ручки нет.
 */
@ApiTags('seller')
@Controller('seller')
@Roles('SELLER')
export class SellerController {
  constructor(private readonly seller: SellerService) {}

  @Get('lots')
  @ApiOperation({ summary: 'Мои лоты с монитором прозрачности' })
  dashboard(@CurrentUser() user: AuthenticatedUser): Promise<SellerDashboardView> {
    return this.seller.dashboard(user.id);
  }
}
