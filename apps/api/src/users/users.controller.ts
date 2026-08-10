import type { MyProfileView } from '@auction/shared';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, RequireEgovVerified } from '../auth/decorators';

import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Мой профиль: ФИО, маскированный ИИН, статус верификации' })
  @ApiOkResponse({ description: 'Профиль владельца аккаунта' })
  myProfile(@CurrentUser() user: AuthenticatedUser): Promise<MyProfileView> {
    return this.users.myProfile(user.id);
  }

  /**
   * Проверка допуска к денежным операциям. Ручка настоящая, не тестовая:
   * ЛК Инвестора (T-036) дёргает её, чтобы показать «пройдите верификацию»
   * до того, как человек начнёт заполнять реквизиты задатка.
   */
  @Get('me/deposit-access')
  @RequireEgovVerified()
  @ApiOperation({ summary: 'Допущен ли пользователь к внесению задатка (нужна верификация eGov)' })
  @ApiOkResponse({ description: 'Пользователь верифицирован и может вносить задаток' })
  depositAccess(@CurrentUser() user: AuthenticatedUser): { allowed: true; userId: string } {
    return { allowed: true, userId: user.id };
  }
}
