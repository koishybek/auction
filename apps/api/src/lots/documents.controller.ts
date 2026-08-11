import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';

import { DocumentsService, type LotDocumentView } from './documents.service';

/**
 * Загрузка идёт base64 в JSON, а не multipart.
 *
 * Причина практическая: multipart тянет отдельный парсер и обходит глобальный
 * Zod-пайп, то есть тело запроса перестаёт валидироваться так же, как везде.
 * Документы Data Room — это единицы файлов по несколько мегабайт, накладные
 * расходы base64 в 33 % здесь дешевле, чем второй путь валидации.
 * Появятся большие файлы — заведём прямую загрузку по подписанной ссылке в S3.
 */
const UploadSchema = z
  .object({
    kind: z.enum(['DATA_ROOM', 'CERT_STO']),
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(3).max(128),
    contentBase64: z.string().min(1),
  })
  .strict();

class UploadDto extends createZodDto(UploadSchema) {}

@ApiTags('lots')
@Controller('lots/:lotId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Витрина Data Room публична: её смотрят до входа в торги. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Документы лота (Data Room)' })
  list(@Param('lotId', ParseUUIDPipe) lotId: string): Promise<readonly LotDocumentView[]> {
    return this.documents.list(lotId);
  }

  @Roles('SELLER')
  @Post()
  @ApiOperation({ summary: 'Загрузить документ лота (только владелец)' })
  @ApiOkResponse({ description: 'Ключ объекта генерирует сервер' })
  upload(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: UploadDto,
    @CurrentUser() seller: AuthenticatedUser,
  ): Promise<LotDocumentView> {
    return this.documents.upload({
      lotId,
      seller,
      kind: body.kind,
      fileName: body.fileName,
      contentType: body.contentType,
      body: Buffer.from(body.contentBase64, 'base64'),
    });
  }

  /**
   * Скачивание с инкрементом счётчика. Публично: интерес к лоту меряется
   * в том числе обращениями анонимов, а сами документы и так витрина.
   */
  @Public()
  @Get(':documentId/download')
  @ApiOperation({ summary: 'Скачать документ (увеличивает счётчик ровно на 1)' })
  async download(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.documents.download(documentId);

    // filename* по RFC 5987: имена файлов кириллицей иначе превращаются в мусор.
    res.set({
      'Content-Type': file.contentType,
      'Content-Length': String(file.sizeBytes),
      'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(
        file.fileName,
      )}`,
    });
    return new StreamableFile(file.stream);
  }
}
