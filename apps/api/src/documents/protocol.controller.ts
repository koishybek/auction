import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ProtocolService } from './protocol.service';

/**
 * Протокол торгов (T-044, FR-06).
 *
 * Доступен любому, кто вошёл: в документе нет персональных данных — участники
 * обозначены псевдонимами лота, — а сам факт и ход торгов не тайна. Скрывать
 * его от участника значило бы прятать доказательство от того, ради кого оно
 * составлено.
 */
@ApiTags('documents')
@Controller('lots/:lotId/protocol')
export class ProtocolController {
  constructor(private readonly protocol: ProtocolService) {}

  @Get()
  @ApiOperation({ summary: 'Протокол торгов: идентификатор документа для скачивания' })
  async info(
    @Param('lotId', ParseUUIDPipe) lotId: string,
  ): Promise<{ documentId: string; fileName: string }> {
    const document = await this.protocol.forLot(lotId);
    return { documentId: document.id, fileName: document.fileName };
  }
}
