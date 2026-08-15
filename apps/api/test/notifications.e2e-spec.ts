import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidService } from '../src/auction/bid.service';
import { SlaFreezeService } from '../src/auction/sla-freeze.service';
import { PiiCryptoService } from '../src/common/crypto/pii-crypto.service';
import { NotificationMockProvider } from '../src/integrations/notifications/notification.mock.provider';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Уведомления участников (T-033, FR-08).
 *
 * DoD: при заморозке в мок-провайдере фиксируются отправки всем участникам
 * лота. Смысл проверки не в самом факте отправки, а в полноте списка: молчание
 * перед человеком, у которого на спецсчёте лежит задаток, — худшее, что может
 * сделать система во время паузы.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let freeze: SlaFreezeService;
let notifications: NotificationsService;
let provider: NotificationMockProvider;
let pii: PiiCryptoService;

/** Лот с торгами и участниками: двое с задатком, один из них уже ставил. */
async function arena(): Promise<{
  lotId: string;
  withDeposit: string;
  bidder: string;
  idle: string;
}> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: 100_000_000n,
      status: 'PHASE_III',
    },
    select: { id: true },
  });
  const session = await prisma.auctionSession.create({
    data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: 100_000_000n });

  const make = async (phone: string | null): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        roles: ['INVESTOR'],
        egovVerifiedAt: new Date(),
        ...(phone === null ? {} : { phoneEnc: pii.encrypt(phone, 'users.phone') }),
      },
      select: { id: true },
    });
    return user.id;
  };

  const withDeposit = await make('+77010000001');
  const bidder = await make('+77010000002');
  // Третий просто смотрит торги: ни задатка, ни ставок — уведомлять его не за что.
  const idle = await make(null);

  for (const userId of [withDeposit, bidder]) {
    await prisma.deposit.create({
      data: { userId, lotId: lot.id, amountTiyn: 10_000_000n, status: 'ON_SPECIAL_ACCOUNT' },
    });
  }

  await bids.place({
    lotId: lot.id,
    bidderId: bidder,
    blindCode: 'Инвестор #704',
    expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
  });

  return { lotId: lot.id, withDeposit, bidder, idle };
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
  freeze = app.get(SlaFreezeService);
  notifications = app.get(NotificationsService);
  provider = app.get(NotificationMockProvider);
  pii = app.get(PiiCryptoService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  provider.reset();
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-033: уведомления Push/SMS', () => {
  it('DoD: заморозка фиксирует отправки всем участникам лота', async () => {
    const { lotId, withDeposit, bidder, idle } = await arena();

    const frozen = await freeze.freeze(lotId, 'проверка');
    expect(frozen).not.toBeNull();

    const sent = provider.sent().filter((r) => r.template === 'auction.sla_freeze');
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((r) => r.userId))).toEqual(new Set([withDeposit, bidder]));

    // Приоритет высокий: ТЗ §2.2 требует именно приоритетного уведомления —
    // человек смотрит на замерший таймер и должен узнать причину сразу.
    expect(sent.every((r) => r.priority === 'HIGH')).toBe(true);
    // В шаблон уходит остаток: сообщение без него бессмысленно.
    expect(sent[0]?.params['time_remaining_ms']).toBe(frozen?.remainingMs);
    expect(sent[0]?.params['resume_in_ms']).toBe(60_000);

    // Зритель без задатка и без ставок не участник — его не беспокоим.
    expect(provider.sentTo(idle)).toHaveLength(0);

    // След в базе: отправку должно быть чем доказать при разборе жалобы.
    const rows = await prisma.notification.findMany({ where: { template: 'auction.sla_freeze' } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'SENT')).toBe(true);
    expect(rows.every((row) => row.sentAt !== null)).toBe(true);
  });

  it('возобновление тоже доходит до участников, но обычным приоритетом', async () => {
    const { lotId } = await arena();
    await freeze.freeze(lotId, 'проверка');
    provider.reset();

    await freeze.resume(lotId);

    const sent = provider.sent().filter((r) => r.template === 'auction.sla_resume');
    expect(sent).toHaveLength(2);
    // Таймер снова идёт и это видно на экране — паники, в отличие от паузы, нет.
    expect(sent.every((r) => r.priority === 'NORMAL')).toBe(true);
  });

  it('недоставка фиксируется, а не теряется', async () => {
    const { lotId } = await arena();
    provider.failOnce();

    await freeze.freeze(lotId, 'проверка');

    const rows = await prisma.notification.findMany({ where: { template: 'auction.sla_freeze' } });
    expect(rows).toHaveLength(2);
    // Одна упала, вторая дошла: строка есть у обеих, и по ней видно, что было.
    expect(rows.filter((r) => r.status === 'FAILED')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'SENT')).toHaveLength(1);
    expect(rows.find((r) => r.status === 'FAILED')?.sentAt).toBeNull();
  });

  it('телефон расшифровывается только на границе с провайдером', async () => {
    const { bidder } = await arena();

    await notifications.notify({
      userId: bidder,
      channel: 'SMS',
      template: 'проверка.sms',
      params: {},
    });

    const [request] = provider.sentTo(bidder);
    // Провайдеру номер нужен открытым — иначе SMS не отправить.
    expect(request?.phone).toBe('+77010000002');

    // А в базе он по-прежнему только в зашифрованном виде.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: bidder } });
    expect(user.phoneEnc).not.toBeNull();
    expect(Buffer.from(user.phoneEnc ?? new Uint8Array()).toString('utf8')).not.toContain('+7701');
  });

  it('push не тянет телефон из базы без надобности', async () => {
    const { bidder } = await arena();

    await notifications.notify({ userId: bidder, template: 'проверка.push', params: {} });

    // Канал по умолчанию push: расшифровывать ПДн незачем, и мы этого не делаем.
    expect(provider.sentTo(bidder)[0]?.phone).toBeNull();
  });

  it('участники лота — это задаток или ставка, а не просмотр', async () => {
    const { lotId, withDeposit, bidder, idle } = await arena();

    const participants = await notifications.lotParticipants(lotId);
    expect(new Set(participants)).toEqual(new Set([withDeposit, bidder]));
    expect(participants).not.toContain(idle);
    // Один и тот же человек с задатком и ставкой считается один раз.
    expect(participants).toHaveLength(2);
  });
});
