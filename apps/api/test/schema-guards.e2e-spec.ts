import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Инварианты, которые держит БД, а не код (T-055).
 *
 * Три частичных индекса созданы голым SQL в миграциях, и в schema.prisma их
 * нет — синтаксиса `WHERE` у `@@index`/`@@unique` не существует. Prisma об этом
 * не знает: любой следующий `prisma migrate dev` сравнивает схему с базой,
 * видит «лишние» индексы и генерирует на них `DROP INDEX`. Пропустить такую
 * строку в диффе миграции легко — она выглядит уборкой мусора.
 *
 * Цена ошибки для каждого:
 *   partner_leads_locked_object_key — единственная защита от двух LOCKED-лидов
 *     на один объект, то есть от спора двух партнёров о комиссии;
 *   deposits_refund_pending_idx — по нему воркер находит задатки к возврату;
 *   deposits_runner_up_idx — по нему находят задаток участника №2.
 *
 * Тест не проверяет производительность. Он проверяет, что индексы существуют:
 * первый — про деньги напрямую, два других — про то, найдёт ли воркер работу.
 */

let app: INestApplication;
let prisma: PrismaService;

interface IndexRow {
  readonly indexname: string;
  readonly indexdef: string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

describe('T-055: частичные индексы на месте', () => {
  it('уникальность LOCKED-лида на объект: partner_leads_locked_object_key', async () => {
    const rows = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'partner_leads' AND indexname = 'partner_leads_locked_object_key'
    `;
    expect(rows).toHaveLength(1);
    // Именно частичный и именно уникальный: без WHERE он запретил бы и
    // истёкшие лиды, без UNIQUE не запрещал бы ничего.
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain("WHERE (status = 'LOCKED'");
  });

  it('поиск задатков к возврату: deposits_refund_pending_idx', async () => {
    const rows = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'deposits' AND indexname = 'deposits_refund_pending_idx'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("status = 'REFUND_PENDING'");
  });

  it('поиск задатка участника №2: deposits_runner_up_idx', async () => {
    const rows = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'deposits' AND indexname = 'deposits_runner_up_idx'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('runner_up_until IS NOT NULL');
  });

  it('append-only на ставках и аудите — триггерами, а не соглашением', async () => {
    // Проверяется существование самих триггеров: правило «ставку нельзя
    // изменить» обязано жить в базе, иначе его обойдёт любой ручной psql.
    const rows = await prisma.$queryRaw<{ tgname: string; relname: string }[]>`
      SELECT t.tgname, c.relname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('bids', 'audit_log')
    `;
    const tables = new Set(rows.map((row) => row.relname));
    expect(tables.has('bids')).toBe(true);
    expect(tables.has('audit_log')).toBe(true);
  });
});
