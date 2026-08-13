import { rm } from 'node:fs/promises';

import type { TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { LotDocumentView } from '../src/lots/documents.service';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase, TEST_STORAGE_ROOT } from './test-db';
import { listenForSupertest } from './test-http';

let app: INestApplication;
let prisma: PrismaService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(tokens: TokenPair): [string, string] {
  return ['Authorization', `Bearer ${tokens.accessToken}`];
}

async function devLogin(roles: readonly string[]): Promise<TokenPair> {
  const response = await api().post('/api/auth/dev-login').send({ roles }).expect(200);
  return response.body as TokenPair;
}

async function createLot(seller: TokenPair): Promise<string> {
  const response = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'REALTY', cadastreOrVin: '20-317-077-4242', startPriceTenge: 30_000_000 })
    .expect(201);
  return (response.body as { id: string }).id;
}

const PDF_BYTES = Buffer.from('%PDF-1.7\nтестовый документ Data Room\n%%EOF');

async function upload(
  seller: TokenPair,
  lotId: string,
  fileName = 'Отчёт об оценке.pdf',
): Promise<LotDocumentView> {
  const response = await api()
    .post(`/api/lots/${lotId}/documents`)
    .set(...auth(seller))
    .send({
      kind: 'DATA_ROOM',
      fileName,
      contentType: 'application/pdf',
      contentBase64: PDF_BYTES.toString('base64'),
    })
    .expect(201);
  return response.body as LotDocumentView;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
  await rm(TEST_STORAGE_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await cleanDatabase(prisma);
});

describe('T-016: Data Room', () => {
  it('продавец загружает документ, ключ генерирует сервер', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    const document = await upload(seller, lotId);

    expect(document.kind).toBe('DATA_ROOM');
    expect(document.downloadsCount).toBe(0);

    const row = await prisma.lotDocument.findUniqueOrThrow({ where: { id: document.id } });
    // Имя файла от пользователя в путь не попадает.
    expect(row.fileKey).toMatch(/^lots\/[0-9a-f-]+\/data_room\/[0-9a-f-]+$/);
    expect(row.fileKey).not.toContain('Отчёт');
    expect(row.sizeBytes).toBe(PDF_BYTES.byteLength);
  });

  it('чужому лоту документ не загрузить', async () => {
    const seller = await devLogin(['SELLER']);
    const other = await devLogin(['SELLER']);
    const lotId = await createLot(seller);

    await api()
      .post(`/api/lots/${lotId}/documents`)
      .set(...auth(other))
      .send({
        kind: 'DATA_ROOM',
        fileName: 'чужое.pdf',
        contentType: 'application/pdf',
        contentBase64: PDF_BYTES.toString('base64'),
      })
      .expect(403);
  });

  it('протокол торгов и Акт ВЕТО загрузить нельзя — их формирует система', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);

    for (const kind of ['PROTOCOL', 'VETO_ACT']) {
      const response = await api()
        .post(`/api/lots/${lotId}/documents`)
        .set(...auth(seller))
        .send({
          kind,
          fileName: 'подделка.pdf',
          contentType: 'application/pdf',
          contentBase64: PDF_BYTES.toString('base64'),
        });
      // Схема не знает таких значений — отсекается ещё валидацией.
      expect(response.status).toBe(400);
    }
  });

  it('пустой файл отклоняется', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);

    await api()
      .post(`/api/lots/${lotId}/documents`)
      .set(...auth(seller))
      .send({
        kind: 'DATA_ROOM',
        fileName: 'пусто.pdf',
        contentType: 'application/pdf',
        contentBase64: Buffer.alloc(0).toString('base64'),
      })
      .expect(400);
  });

  it('витрина документов видна анониму, скачивание отдаёт исходные байты', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    const document = await upload(seller, lotId);

    const list = await api().get(`/api/lots/${lotId}/documents`).expect(200);
    expect(list.body as LotDocumentView[]).toHaveLength(1);

    const download = await api()
      .get(`/api/lots/${lotId}/documents/${document.id}/download`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          callback(null, Buffer.concat(chunks));
        });
      })
      .expect(200);

    expect(Buffer.from(download.body as Buffer).equals(PDF_BYTES)).toBe(true);
    expect(download.headers['content-type']).toContain('application/pdf');
    // Кириллица в имени — через filename* по RFC 5987, иначе на выходе мусор.
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('имя файла очищается от пути: подстановка ../ не выходит за хранилище', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    const document = await upload(seller, lotId, '../../../../.env');

    const row = await prisma.lotDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.fileName).toBe('.env');
    expect(row.fileName).not.toContain('..');
  });

  it('DoD: 20 одновременных скачиваний дают ровно 20', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    const document = await upload(seller, lotId);

    // Инкремент средствами БД, а не чтение-запись из кода: при чтении-записи
    // часть скачиваний потерялась бы, и цифра для продавца врала бы.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api()
          .get(`/api/lots/${lotId}/documents/${document.id}/download`)
          .then((response) => response.status),
      ),
    );

    expect(results.every((status) => status === 200)).toBe(true);

    const row = await prisma.lotDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.downloadsCount).toBe(20);
  });

  it('несуществующий документ — 404', async () => {
    const seller = await devLogin(['SELLER']);
    const lotId = await createLot(seller);
    await api().get(`/api/lots/${lotId}/documents/${crypto.randomUUID()}/download`).expect(404);
  });
});
