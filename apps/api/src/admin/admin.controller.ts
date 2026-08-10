import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';

import { AdminService, type AdminUserListView } from './admin.service';

const ListUsersSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  })
  .strict();

const SetStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'BLOCKED']),
    /** Причина обязательна: она уходит в audit_log, безликих блокировок не бывает. */
    reason: z.string().min(3).max(500),
  })
  .strict();

class ListUsersDto extends createZodDto(ListUsersSchema) {}
class SetStatusDto extends createZodDto(SetStatusSchema) {}

/** Весь контроллер только для ADMIN — класс-уровневый @Roles. Задача вне ТЗ (ОВ-8). */
@ApiTags('admin')
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @ApiOperation({ summary: 'Список пользователей (фильтр по статусу, пагинация)' })
  @ApiOkResponse({ description: 'Просмотр фиксируется в audit_log' })
  listUsers(
    @Query() query: ListUsersDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AdminUserListView> {
    return this.admin.listUsers({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      actorId: actor.id,
    });
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Заблокировать / разблокировать пользователя' })
  @ApiOkResponse({ description: 'Блокировка гасит все сессии пользователя' })
  setStatus(
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() body: SetStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ id: string; status: 'ACTIVE' | 'BLOCKED'; sessionsRevoked: number }> {
    return this.admin.setUserStatus({
      userId,
      status: body.status,
      actorId: actor.id,
      reason: body.reason,
    });
  }
}
