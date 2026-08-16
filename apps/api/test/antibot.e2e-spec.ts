import { randomUUID } from 'node:crypto';

import type { BehaviorSignals } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AntibotService } from '../src/antibot/antibot.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionStateService } from '../src/auction/auction-state.service';
import { BidPlacementService } from '../src/auction/bid-placement.service';
import { BidService } from '../src/auction/bid.service';
import { CaptchaMockProvider } from '../src/integrations/captcha/captcha.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Поведенческий антибот (T-049, FR-11, ОВ-5).
 *
 * DoD: синтетический клик получает челлендж, живой проходит. Цена ошибки
 * несимметрична — пропущенный автомат поднимет цену на шаг, отказанный
 * человек потеряет лот, — поэтому санкция мягкая: не запрет, а проверка.
 */

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let state: AuctionStateService;
let bids: BidService;
let placement: BidPlacementService;
let antibot: AntibotService;
let captcha: CaptchaMockProvider;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

/** Живой клик: курсор шёл к кнопке и постоял над ней. */
const HUMAN: BehaviorSignals = {
  trusted: true,
  kind: 'mouse',
  moves: 24,
  pathPx: 320,
  dwellMs: 260,
};
/** Синтетический: событие сгенерировано кодом страницы. */
const SYNTHETIC: BehaviorSignals = {
  trusted: false,
  kind: 'mouse',
  moves: 0,
  pathPx: 0,
  dwellMs: 0,
};

interface Arena {
  readonly lotId: string;
  readonly buyer: string;
}

/** Ещё один участник с задатком: перебивать собственную ставку нельзя. */
async function eligibleBuyer(lotId: string): Promise<string> {
  const buyer = await prisma.user.create({
    data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
    select: { id: true },
  });
  await prisma.deposit.create({
    data: { lotId, userId: buyer.id, amountTiyn: 10_000_000n, status: 'ON_SPECIAL_ACCOUNT' },
  });
  return buyer.id;
}

async function arena(): Promise<Arena> {
  const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
  const lot = await prisma.lot.create({
    data: {
      sellerId: seller.id,
      type: 'REALTY',
      cadastreOrVin: `LOT-${randomUUID()}`,
      startPriceTiyn: 1_000_000_00n,
      status: 'PHASE_III',
    },
    select: { id: true, startPriceTiyn: true },
  });
  const session = await prisma.auctionSession.create({
    data: { lotId: lot.id, status: 'RUNNING', deadlineAt: new Date(Date.now() + 50_000) },
    select: { id: true },
  });
  await state.start({ lotId: lot.id, sessionId: session.id, priceTiyn: lot.startPriceTiyn });

  const buyer = await prisma.user.create({
    data: { roles: ['INVESTOR'], egovVerifiedAt: new Date() },
    select: { id: true },
  });
  await prisma.deposit.create({
    data: {
      lotId: lot.id,
      userId: buyer.id,
      amountTiyn: 10_000_000n,
      status: 'ON_SPECIAL_ACCOUNT',
    },
  });
  return { lotId: lot.id, buyer: buyer.id };
}

/**
 * Пауза между ставками одной сессии.
 *
 * Не для устойчивости теста, а по правилу FR-10: чаще одной ставки в 500 мс с
 * одной сессии система не принимает, и без паузы вторая законно получает
 * RATE_LIMITED вместо проверяемого кода.
 */
async function pauseForRateLimit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

async function bid(
  arenaData: Arena,
  sessionId: string,
  behavior: BehaviorSignals | null,
): Promise<string> {
  const result = await placement.place({
    lotId: arenaData.lotId,
    userId: arenaData.buyer,
    expectedAmountTiyn: await bids.nextPriceTiyn(arenaData.lotId),
    sessionId,
    behavior,
  });
  return result.status === 'REJECTED' ? result.code : 'ACCEPTED';
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
  placement = app.get(BidPlacementService);
  antibot = app.get(AntibotService);
  captcha = app.get(CaptchaMockProvider);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
  captcha.reset();
});

describe('T-049: поведенческий антибот', () => {
  it('DoD: живой клик проходит, синтетический получает капчу', async () => {
    const scene = await arena();

    expect(await bid(scene, `session-${randomUUID()}`, HUMAN)).toBe('ACCEPTED');
    expect(await bid(scene, `session-${randomUUID()}`, SYNTHETIC)).toBe('CAPTCHA_REQUIRED');
  });

  it('клавиатурная активация проходит без вопросов', async () => {
    const scene = await arena();

    // Требование доступности: у человека без мыши движений курсора нет по
    // определению, и наказывать его за это нельзя.
    const keyboard: BehaviorSignals = {
      trusted: true,
      kind: 'keyboard',
      moves: 0,
      pathPx: 0,
      dwellMs: 0,
    };
    expect(await bid(scene, `session-${randomUUID()}`, keyboard)).toBe('ACCEPTED');

    // И тап по телефону: траектории у него не бывает вовсе. Ставит другой
    // участник — перебивать собственную ставку нельзя (T-025).
    const tap: BehaviorSignals = { trusted: true, kind: 'touch', moves: 0, pathPx: 0, dwellMs: 0 };
    await pauseForRateLimit();
    const second = await eligibleBuyer(scene.lotId);
    expect(await bid({ lotId: scene.lotId, buyer: second }, `session-${randomUUID()}`, tap)).toBe(
      'ACCEPTED',
    );
  });

  it('клиент без сигналов проходит: барьер для таких стоит на входе', async () => {
    const scene = await arena();

    // Не-браузерный клиент (мобильное приложение, нагрузочный стенд) сигналов
    // не шлёт. Требовать их — значит бить по честным и ничего не дать против
    // самописного бота: тот пришлёт любые цифры. Его останавливает Cloudflare.
    expect(await bid(scene, `session-${randomUUID()}`, null)).toBe('ACCEPTED');
  });

  it('санкция действует на сессию, а не на человека', async () => {
    const scene = await arena();
    const punished = `session-${randomUUID()}`;

    expect(await bid(scene, punished, SYNTHETIC)).toBe('CAPTCHA_REQUIRED');
    await pauseForRateLimit();

    // Другой сокет того же участника не наказан: иначе один странный клик
    // выбивал бы человека из торгов целиком.
    const other = await eligibleBuyer(scene.lotId);
    expect(await bid({ lotId: scene.lotId, buyer: other }, `session-${randomUUID()}`, HUMAN)).toBe(
      'ACCEPTED',
    );
  });

  it('требование держится, пока капча не решена', async () => {
    const scene = await arena();
    const sessionId = `session-${randomUUID()}`;

    expect(await bid(scene, sessionId, SYNTHETIC)).toBe('CAPTCHA_REQUIRED');
    await pauseForRateLimit();

    // Живой клик той же сессией требование не отменяет: иначе автомату
    // достаточно было бы подрисовать движение следующим сообщением.
    expect(await bid(scene, sessionId, HUMAN)).toBe('CAPTCHA_REQUIRED');
    await pauseForRateLimit();

    expect(await antibot.solve({ sessionId, token: 'solved-abc', remoteIp: '203.0.113.9' })).toBe(
      true,
    );
    expect(await bid(scene, sessionId, HUMAN)).toBe('ACCEPTED');
  });

  it('негодный токен требование не снимает', async () => {
    const scene = await arena();
    const sessionId = `session-${randomUUID()}`;
    await bid(scene, sessionId, SYNTHETIC);

    expect(await antibot.solve({ sessionId, token: 'подделка', remoteIp: null })).toBe(false);
    await pauseForRateLimit();
    expect(await bid(scene, sessionId, HUMAN)).toBe('CAPTCHA_REQUIRED');
  });

  it('адрес уходит провайдеру вместе с токеном', async () => {
    const scene = await arena();
    const sessionId = `session-${randomUUID()}`;
    await bid(scene, sessionId, SYNTHETIC);
    await antibot.solve({ sessionId, token: 'solved-xyz', remoteIp: '198.51.100.4' });

    // Тот же токен с другого адреса — признак перепродажи решённых капч.
    expect(captcha.attempts()[0]?.remoteIp).toBe('198.51.100.4');
  });

  it('ручка снятия требует входа и отвергает подделку', async () => {
    const scene = await arena();
    const sessionId = `session-${randomUUID()}`;
    await bid(scene, sessionId, SYNTHETIC);

    await api().post('/api/auction/captcha').send({ token: 'solved-1', sessionId }).expect(401);

    const tokens = await api()
      .post('/api/auth/dev-login')
      .send({ roles: ['INVESTOR'] })
      .expect(200);
    const accessToken = (tokens.body as { accessToken: string }).accessToken;

    await api()
      .post('/api/auction/captcha')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'мусор', sessionId })
      .expect(403);

    await api()
      .post('/api/auction/captcha')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'solved-ok', sessionId })
      .expect(200);

    await pauseForRateLimit();
    expect(await bid(scene, sessionId, HUMAN)).toBe('ACCEPTED');
  });
});
