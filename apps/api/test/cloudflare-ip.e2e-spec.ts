import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Адрес клиента за Cloudflare (T-050, NFR-05).
 *
 * Проверяется главное: при выключенном доверии заголовок `CF-Connecting-IP`
 * не читается вовсе. На адресе держатся лимит ставок (FR-10) и антинакрутка
 * просмотров (FR-15) — поверив подделке, система отдаёт оба механизма тому,
 * кто их обходит.
 *
 * Прогон идёт с настройками по умолчанию (`TRUST_CLOUDFLARE_IP=false`) — это и
 * есть состояние, в котором система оказывается, если про флаг забыли.
 */

let app: INestApplication;
let prisma: PrismaService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);
  prisma = app.get(PrismaService);
  await cleanDatabase(prisma);
});

afterAll(async () => {
  await app.close();
});

describe('T-050: адрес клиента за Cloudflare', () => {
  it('подделанный CF-Connecting-IP не подменяет сессию входа', async () => {
    const response = await api()
      .post('/api/auth/dev-login')
      .set('CF-Connecting-IP', '203.0.113.77')
      .send({ roles: ['INVESTOR'] })
      .expect(200);

    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${(response.body as { accessToken: string }).accessToken}`)
      .expect(200);

    const session = await prisma.authSession.findFirstOrThrow({
      where: { userId: (me.body as { id: string }).id },
    });

    // Доверие выключено — записан адрес сокета, а не присланный заголовок.
    expect(session.ip).not.toBe('203.0.113.77');
  });

  it('дубли заголовка ничего не ломают', async () => {
    // Повторённый заголовок — классический способ протащить второе значение.
    await api()
      .post('/api/auth/dev-login')
      .set('CF-Connecting-IP', '198.51.100.1')
      .set('X-Forwarded-For', '198.51.100.2, 203.0.113.3')
      .send({ roles: ['INVESTOR'] })
      .expect(200);

    const sessions = await prisma.authSession.findMany({ select: { ip: true } });
    for (const session of sessions) {
      expect(session.ip).not.toBe('198.51.100.1');
      expect(session.ip).not.toBe('198.51.100.2');
    }
  });
});
