import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import type { DocumentKind } from '../generated/prisma/enums';
import { STORAGE_PROVIDER, type StorageProvider } from '../integrations/storage/storage.types';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

export interface LotDocumentView {
  readonly id: string;
  readonly lotId: string;
  readonly kind: DocumentKind;
  readonly fileName: string;
  readonly downloadsCount: number;
  readonly createdAt: string;
}

/** 25 МБ: документы Data Room — это PDF и сканы, не видео. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Что продавец вправе загружать сам. Протокол торгов и Акт ВЕТО генерирует
 * система (T-044, T-045) — подделать их загрузкой нельзя.
 */
const SELLER_UPLOADABLE: readonly DocumentKind[] = ['DATA_ROOM', 'CERT_STO'];

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async upload(input: {
    lotId: string;
    seller: AuthenticatedUser;
    kind: DocumentKind;
    fileName: string;
    contentType: string;
    body: Buffer;
  }): Promise<LotDocumentView> {
    const lot = await this.prisma.lot.findUnique({ where: { id: input.lotId } });
    if (!lot) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }
    if (lot.sellerId !== input.seller.id) {
      throw new ForbiddenException({ code: 'NOT_LOT_OWNER' });
    }
    if (!SELLER_UPLOADABLE.includes(input.kind)) {
      throw new ForbiddenException({
        code: 'KIND_NOT_UPLOADABLE',
        message: 'Протокол торгов и Акт ВЕТО формирует система, загрузить их нельзя',
      });
    }
    if (input.body.byteLength === 0) {
      throw new BadRequestException({ code: 'EMPTY_FILE' });
    }
    if (input.body.byteLength > MAX_FILE_BYTES) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: `Не больше ${String(MAX_FILE_BYTES / 1024 / 1024)} МБ`,
      });
    }

    // Ключ генерируем сами: имя файла от пользователя в путь не попадает никогда.
    const key = `lots/${lot.id}/${input.kind.toLowerCase()}/${randomUUID()}`;
    await this.storage.put({ key, body: input.body, contentType: input.contentType });

    const document = await this.prisma.lotDocument.create({
      data: {
        lotId: lot.id,
        kind: input.kind,
        fileKey: key,
        fileName: sanitizeFileName(input.fileName),
        contentType: input.contentType,
        sizeBytes: input.body.byteLength,
        createdAt: new Date(this.time.wallClockMs()),
      },
    });

    return toView(document);
  }

  /** Список документов лота — витрина Data Room. */
  async list(lotId: string): Promise<readonly LotDocumentView[]> {
    const documents = await this.prisma.lotDocument.findMany({
      where: { lotId },
      orderBy: { createdAt: 'asc' },
    });
    return documents.map(toView);
  }

  /**
   * Выдача файла со счётчиком скачиваний.
   *
   * Счётчик инкрементируется атомарно средствами БД (`increment`), а не
   * чтением-записью из кода: продавец смотрит на эту цифру как на меру
   * интереса к лоту, и двадцать одновременных скачиваний обязаны дать
   * ровно двадцать (DoD T-016).
   *
   * Инкремент идёт ДО отдачи потока: иначе оборванная загрузка оставила бы
   * счётчик несчитанным, а нам важен факт запроса документа.
   */
  async download(documentId: string): Promise<{
    stream: Readable;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }> {
    const document = await this.prisma.lotDocument.findUnique({ where: { id: documentId } });
    if (!document) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    }

    await this.prisma.lotDocument.update({
      where: { id: documentId },
      data: { downloadsCount: { increment: 1 } },
    });

    const handle = await this.storage.get(document.fileKey);
    if (!handle) {
      // Запись в БД есть, объекта нет — рассинхрон хранилища, не вина клиента.
      throw new NotFoundException({ code: 'OBJECT_MISSING' });
    }

    return {
      stream: handle.stream,
      fileName: document.fileName,
      contentType: document.contentType,
      sizeBytes: handle.sizeBytes,
    };
  }
}

function toView(document: {
  id: string;
  lotId: string;
  kind: DocumentKind;
  fileName: string;
  downloadsCount: number;
  createdAt: Date;
}): LotDocumentView {
  return {
    id: document.id,
    lotId: document.lotId,
    kind: document.kind,
    fileName: document.fileName,
    downloadsCount: document.downloadsCount,
    createdAt: document.createdAt.toISOString(),
  };
}

/**
 * Имя файла уходит в заголовок Content-Disposition и на экран пользователю.
 * Срезаем путь и всё, что ломает заголовок: перевод строки в имени — это
 * инъекция заголовков ответа.
 */
function sanitizeFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').trim();
  const forbidden = '<>:"|?*\\/';
  const clean = Array.from(base)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || forbidden.includes(char) ? '_' : char;
    })
    .join('');
  return clean === '' ? 'document' : clean.slice(0, 200);
}
