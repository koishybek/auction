import type { ServerTimeReport } from '@auction/shared';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators';

import { TimeService } from './time.service';

// Открыто намеренно: клиенту нужно сверить часы до входа в систему,
// а секрета в серверном времени нет.
@Public()
@ApiTags('time')
@Controller('time')
export class TimeController {
  constructor(private readonly time: TimeService) {}

  /**
   * Серверное время. Клиент использует его, чтобы понять расхождение своих часов
   * с сервером, но в расчёте таймера торгов его часы не участвуют: остаток
   * приходит готовым числом в событиях WS.
   */
  @Get()
  @ApiOperation({ summary: 'Серверное время: стенные часы и монотонный счётчик' })
  @ApiOkResponse({ description: 'Текущее серверное время' })
  now(): ServerTimeReport {
    return this.time.now();
  }
}
