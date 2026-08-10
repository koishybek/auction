import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { LivenessReport, ReadinessReport } from '@auction/shared';
import type { Response } from 'express';

import { Public } from '../auth/decorators';

import { HealthService } from './health.service';

// Пробы Kubernetes ходят без токена — иначе kubelet получит 401 и убьёт под.
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. Отвечает, пока жив процесс, и намеренно НЕ трогает внешние зависимости.
   *
   * Если завязать liveness на БД, то падение Postgres заставит kubelet перезапускать
   * совершенно исправные поды — во время торгов это добьёт систему вместо починки.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness: процесс жив' })
  @ApiOkResponse({ description: 'Процесс отвечает' })
  live(): LivenessReport {
    return { status: 'ok', uptimeSec: Math.floor(process.uptime()) };
  }

  /**
   * Readiness. Проверяет зависимости и отдаёт 503, если хоть одна недоступна, —
   * балансировщик перестаёт слать трафик, но под не перезапускается.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: зависимости доступны' })
  @ApiOkResponse({ description: 'PostgreSQL и Redis отвечают' })
  @ApiServiceUnavailableResponse({ description: 'Хотя бы одна зависимость недоступна' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.checkReadiness();
    res.status(report.status === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
