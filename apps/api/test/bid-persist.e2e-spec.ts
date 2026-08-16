import {
  SMART_HAMMER_TIMER_MS,
  type BidUpdatedEvent,
  type EgovLoginResult,
  type LotView,
  type TokenPair,
} from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidOutboxService } from '../src/auction/bid-outbox.service';
import { BidService } from '../src/auction/bid.service';
import { FinisherService } from '../src/auction/finisher.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Персист ставок (T-028).
 *
 * DoD: после тысячи ставок число строк в PostgreSQL совпадает с seq в Redis, а
 * формат ленты валидируется контрактом. Расхождение здесь означало бы ставку,
 * которую участники видели и по которой двигалась цена, но которой нет в базе —
 * то есть нечем доказать в споре.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let outbox: BidOutboxService;
let finisher: FinisherService;

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

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

function uniqueVin(): string {
  return `VIN${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
}

async function egovLogin(iin: string): Promise<TokenPair> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin, fio: 'Тестовый Участник', biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');
  return result.tokens;
}

async function userId(tokens: TokenPair): Promise<string> {
  const me = await api()
    .get('/api/auth/me')
    .set(...auth(tokens))
    .expect(200);
  return (me.body as { id: string }).id;
}

/** Лот в торгах и два участника, которые могут перебивать друг друга. */
async function arena(): Promise<{ lot: LotView; first: string; second: string }> {
  const admin = await devLogin(['ADMIN']);
  const sellerTokens = await egovLogin(randomIin());
  const sellerId = await userId(sellerTokens);
  await api()
    .patch(`/api/admin/users/${sellerId}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'продавец в тесте' })
    .expect(200);

  const created = await api()
    .post('/api/lots')
    .set(...auth(sellerTokens))
    .send({ type: 'REALTY', cadastreOrVin: uniqueVin(), startPriceTenge: 1_000_000 })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(sellerTokens))
    .expect(200);
  for (const to of ['PHASE_I', 'PHASE_II'] as const) {
    await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to, reason: 'проводка в тесте' })
      .expect(200);
  }
  await api()
    .post(`/api/admin/lots/${lot.id}/auction/start`)
    .set(...auth(admin))
    .expect(200);

  return {
    lot,
    first: await userId(await egovLogin(randomIin())),
    second: await userId(await egovLogin(randomIin())),
  };
}

/**
 * Разобрать outbox до конца.
 *
 * Признак конца — пустой заход, а не нулевой pendingCount: тот считает
 * неподтверждённые записи и обнуляется сразу после подтверждения пачки, хотя
 * в потоке ждут ещё непрочитанные.
 */
async function drainAll(): Promise<number> {
  let total = 0;
  for (;;) {
    const written = await outbox.drain(500);
    if (written === 0) {
      return total;
    }
    total += written;
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  state = app.get(AuctionStateService);
  bids = app.get(BidService);
  outbox = app.get(BidOutboxService);
  finisher = app.get(FinisherService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-028: персист ставок и лента истории', () => {
  it('DoD: после 1000 ставок count(PG) = seq(Redis)', async () => {
    /**
     * Тысяча ставок разложена на пять лотов по двести.
     *
     * Подряд по одному лоту столько не бывает и быть не может: шаг +3 %
     * возводится в степень, и на шестистах ставках цена от миллиона тенге
     * доходит до 9·10¹³ — за пределы точных целых чисел Lua. Система там не
     * ошибается в деньгах, она перестаёт принимать ставки (PRICE_MISMATCH),
     * но проверять персист в этой зоне бессмысленно. Двести шагов дают
     * 3,6·10⁸ ₸ — сумма крупная, но реальная.
     */
    const arenas = [await arena(), await arena(), await arena(), await arena(), await arena()];

    for (const { lot, first, second } of arenas) {
      // Участники чередуются: перебивать себя нельзя (T-025).
      for (let i = 0; i < 200; i += 1) {
        const outcome = await bids.place({
          lotId: lot.id,
          bidderId: i % 2 === 0 ? first : second,
          blindCode: `Инвестор #${String(100 + (i % 2))}`,
          expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
        });
        if (outcome.status !== 'ACCEPTED') {
          throw new Error(`Лот ${lot.id}, ставка ${String(i)} отклонена: ${outcome.code}`);
        }
      }
    }

    await drainAll();

    let totalSeq = 0;
    let totalStored = 0;
    for (const { lot } of arenas) {
      const live = await state.read(lot.id);
      expect(live?.seq).toBe(200);
      totalSeq += live?.seq ?? 0;

      const stored = await prisma.bid.count({ where: { lotId: lot.id } });
      totalStored += stored;

      // Номера идут подряд, без дыр: seq присваивает атомарный скрипт.
      const seqs = await prisma.bid.findMany({
        where: { lotId: lot.id },
        select: { seq: true },
        orderBy: { seq: 'asc' },
      });
      expect(seqs[0]?.seq).toBe(1);
      expect(seqs[seqs.length - 1]?.seq).toBe(200);
      expect(new Set(seqs.map((b) => b.seq)).size).toBe(200);
    }

    // Сверка: ни одна принятая ставка не потерялась по дороге в базу.
    expect(totalSeq).toBe(1000);
    expect(totalStored).toBe(totalSeq);
  }, 300_000);

  it('повторная доставка не создаёт дубль', async () => {
    const { lot, first } = await arena();
    await bids.place({
      lotId: lot.id,
      bidderId: first,
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
    });
    await drainAll();
    expect(await prisma.bid.count({ where: { lotId: lot.id } })).toBe(1);

    // Возвращаем запись в поток — так выглядит повтор при падении между
    // чтением и подтверждением. Спасает уникальный (session_id, seq).
    const session = await prisma.auctionSession.findFirstOrThrow({ where: { lotId: lot.id } });
    await redis.client.xadd(
      bids.outboxKey(),
      '*',
      'lotId',
      lot.id,
      'sessionId',
      session.id,
      'userId',
      first,
      'amountTiyn',
      '103000000',
      'seq',
      '1',
      'blindCode',
      'Инвестор #704',
      'serverTs',
      String(Date.now()),
    );
    await drainAll();

    expect(await prisma.bid.count({ where: { lotId: lot.id } })).toBe(1);
  });

  it('контракт ленты: формат строго как у bid_updated из ТЗ', async () => {
    const { lot, first, second } = await arena();
    for (const [index, bidder] of [first, second, first].entries()) {
      await bids.place({
        lotId: lot.id,
        bidderId: bidder,
        blindCode: `Инвестор #${String(700 + index)}`,
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
    }
    await drainAll();

    const response = await api().get(`/api/lots/${lot.id}/auction/bids`).expect(200);
    const feed = response.body as BidUpdatedEvent[];

    expect(feed).toHaveLength(3);
    // Свежие сверху: лента читается сверху вниз.
    expect(feed.map((item) => item.seq)).toEqual([3, 2, 1]);

    const [latest] = feed;
    expect(latest).toBeDefined();
    if (latest === undefined) return;

    // Набор полей ровно тот, что задан ТЗ §2.1, плюс seq и session_id для
    // ресинка и next_price_kzt для кнопки: правило шага живёт на сервере, и
    // клиент не должен считать +3 % второй реализацией (T-039).
    expect(Object.keys(latest).sort()).toEqual(
      [
        'bid_step_kzt',
        'current_price_kzt',
        'event',
        'last_bidder_blind_id',
        'lot_id',
        'next_price_kzt',
        'seq',
        'session_id',
        'time_remaining_ms',
        'timestamp',
      ].sort(),
    );
    expect(latest.event).toBe('bid_updated');
    expect(latest.lot_id).toBe(lot.id);
    expect(latest.time_remaining_ms).toBe(SMART_HAMMER_TIMER_MS);
    expect(Number.isInteger(latest.current_price_kzt)).toBe(true);
    expect(Number.isInteger(latest.bid_step_kzt)).toBe(true);

    // 1 000 000 → 1 030 000 → 1 060 900 → 1 092 727
    expect(feed.map((item) => item.current_price_kzt)).toEqual([1_092_727, 1_060_900, 1_030_000]);
    // Шаг первой ставки считается от стартовой цены лота.
    expect(feed[2]?.bid_step_kzt).toBe(30_000);
    // Следующая цена для записи ленты — это сумма ставки, пришедшей после неё.
    expect(feed[2]?.next_price_kzt).toBe(1_060_900);
    expect(feed[1]?.next_price_kzt).toBe(1_092_727);

    // Реальных участников в ленте нет — только псевдонимы (FR-09).
    expect(JSON.stringify(feed)).not.toContain(first);
    expect(JSON.stringify(feed)).not.toContain(second);
  });

  it('лента ограничена и не отдаёт всю сессию разом', async () => {
    const { lot, first, second } = await arena();
    for (let i = 0; i < 5; i += 1) {
      await bids.place({
        lotId: lot.id,
        bidderId: i % 2 === 0 ? first : second,
        blindCode: 'Инвестор #704',
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
    }
    await drainAll();

    const limited = await api().get(`/api/lots/${lot.id}/auction/bids?limit=2`).expect(200);
    expect((limited.body as BidUpdatedEvent[]).map((b) => b.seq)).toEqual([5, 4]);

    // Потолок соблюдается: 500 не пройдёт валидацию.
    await api().get(`/api/lots/${lot.id}/auction/bids?limit=500`).expect(400);
  });

  it('у завершённых торгов ставка победителя есть в базе', async () => {
    const { lot, first, second } = await arena();
    await bids.place({
      lotId: lot.id,
      bidderId: first,
      blindCode: 'Инвестор #100',
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
    });
    await bids.place({
      lotId: lot.id,
      bidderId: second,
      blindCode: 'Инвестор #704',
      expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
    });
    await drainAll();

    await redis.client.hset(state.stateKey(lot.id), 'deadlineMs', String(Date.now() - 1));
    const outcome = await finisher.finishLot(lot.id);
    expect(outcome.kind).toBe('FINISHED');
    if (outcome.kind !== 'FINISHED') return;

    // Победитель из события совпадает с последней ставкой в базе — теперь
    // итог торгов доказуем не только состоянием Redis.
    const winning = await prisma.bid.findFirstOrThrow({
      where: { lotId: lot.id },
      orderBy: { seq: 'desc' },
    });
    expect(winning.blindCode).toBe(outcome.winnerBlindId);
    expect(winning.userId).toBe(outcome.winnerUserId);
    expect(winning.amountTiyn).toBe(outcome.finalPriceTiyn);
  });
});
