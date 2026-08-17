import {
  SMART_HAMMER_TIMER_MS,
  type EgovLoginResult,
  type LotView,
  type TokenPair,
} from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { BidOutboxService } from '../src/auction/bid-outbox.service';
import { BidService } from '../src/auction/bid.service';
import { DepositPaymentsService } from '../src/deposits/deposit-payments.service';
import { GatewayModule } from '../src/gateway/gateway.module';
import { BankMockProvider } from '../src/integrations/bank/bank.mock.provider';
import { WsGatewayService } from '../src/gateway/ws-gateway.service';
import { MetricsServer } from '../src/metrics/metrics.server';
import { MetricsService } from '../src/metrics/metrics.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeModule } from '../src/realtime.module';
import { RedisService } from '../src/redis/redis.service';

import { cleanDatabase, cleanRedis } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * WS-gateway (T-023).
 *
 * Главное здесь — DoD: два инстанса за балансировщиком, событие, опубликованное
 * через один, доходит до клиентов обоих. Без этого горизонтальное
 * масштабирование существует только на бумаге, а участник, попавший на «не тот»
 * инстанс, не видит чужих ставок.
 */

let app: INestApplication;
/** Второй инстанс gateway — отдельный контейнер, как отдельный под в кластере. */
let second: TestingModule;
let prisma: PrismaService;
let redis: RedisService;
let bids: BidService;
let outbox: BidOutboxService;
let portA = 0;
let portB = 0;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

/**
 * Сумма значений метрики из текста экспозиции.
 *
 * Читаем именно текст, а не внутренний объект реестра: Prometheus видит этот
 * текст, и проверять надо то, что увидит он. Метка фильтруется подстрокой —
 * порядок меток в выводе не гарантирован ничем.
 */
function sumSamples(body: string, metricName: string, label?: string): number {
  let total = 0;
  for (const line of body.split('\n')) {
    if (!line.startsWith(metricName)) {
      continue;
    }
    // Имя должно совпасть целиком: иначе auction_bids_total поймает и
    // auction_bids_total_something.
    const rest = line.slice(metricName.length);
    if (rest !== '' && !rest.startsWith('{') && !rest.startsWith(' ')) {
      continue;
    }
    if (label !== undefined && !line.includes(label)) {
      continue;
    }
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

interface MetricSnapshot {
  readonly bidsAccepted: number;
  readonly bidObservations: number;
  readonly coreObservations: number;
  readonly broadcasts: number;
  readonly rttObservations: number;
  readonly connections: number;
  readonly largestRoom: number;
}

async function counters(metrics: MetricsService): Promise<MetricSnapshot> {
  const { body } = await metrics.scrape();
  return {
    bidsAccepted: sumSamples(body, 'auction_bids_total', 'outcome="accepted"'),
    bidObservations: sumSamples(body, 'auction_bid_duration_seconds_count'),
    coreObservations: sumSamples(body, 'auction_bid_core_duration_seconds_count'),
    broadcasts: sumSamples(body, 'auction_broadcast_duration_seconds_count'),
    rttObservations: sumSamples(body, 'auction_heartbeat_rtt_seconds_count'),
    connections: sumSamples(body, 'auction_gateway_connections'),
    largestRoom: sumSamples(body, 'auction_gateway_room_connections_max'),
  };
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
    .send({ sessionId, iin, fio: 'Тестовый Продавец', biometricConfirmed: true })
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

async function sellerLogin(admin: TokenPair): Promise<TokenPair> {
  const tokens = await egovLogin(randomIin());
  await api()
    .patch(`/api/admin/users/${await userId(tokens)}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'выдача роли продавца в тесте' })
    .expect(200);
  return tokens;
}

/** Лот с открытыми торгами: gateway пускает в комнату только такие. */
async function lotInAuction(): Promise<{ lot: LotView; admin: TokenPair }> {
  const admin = await devLogin(['ADMIN']);
  const seller = await sellerLogin(admin);

  const created = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'REALTY', cadastreOrVin: uniqueVin(), startPriceTenge: 1_000_000 })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(seller))
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

  return { lot, admin };
}

/**
 * Настоящий участник в базе.
 *
 * Ядру ставки id безразличен — оно принимает его строкой и не ходит в базу.
 * Но там, где тест доводит ставку до PostgreSQL, нужен реальный пользователь:
 * колонка user_id имеет тип uuid и внешний ключ.
 */
async function investorId(): Promise<string> {
  return userId(await egovLogin(randomIin()));
}

/** Клиент WS с накоплением полученных событий. */
interface Client {
  readonly socket: WebSocket;
  readonly messages: Record<string, unknown>[];
  send(message: unknown): void;
  waitFor(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function connect(port: number, cookie?: string): Promise<Client> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${String(port)}`,
    cookie === undefined ? undefined : { headers: { cookie } },
  );
  const messages: Record<string, unknown>[] = [];

  socket.on('message', (data: unknown) => {
    const message = JSON.parse(String(data)) as Record<string, unknown>;
    messages.push(message);
    // Отвечаем на ping, как настоящий клиент. Молчащее соединение считается
    // деградировавшим, и лот уходит в SLA Freeze — тест про ставку начинает
    // падать не потому, что ставка сломана, а потому что торги заморожены.
    if (message['event'] === 'ping' && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'pong' }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    socket,
    messages,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    waitFor: async (event: string, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find((item) => item['event'] === event);
        if (found !== undefined) {
          return found;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Не дождались «${event}». Пришло: ${messages.map((m) => String(m['event'])).join(', ') || '(ничего)'}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => {
      socket.close();
    },
  };
}

beforeAll(async () => {
  // Инстанс А: HTTP-API и gateway в одном контейнере — так тесту доступны и
  // ручки создания лота, и ядро ставки.
  const first = await Test.createTestingModule({ imports: [AppModule, GatewayModule] }).compile();
  app = first.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  bids = app.get(BidService);
  outbox = app.get(BidOutboxService);

  // Инстанс Б: только realtime-контур, свой контейнер и своя подписка на Redis.
  // Это и есть «второй под за балансировщиком».
  second = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
  await second.init();

  // Порт 0 — ОС выдаёт свободный: два сервера в одном процессе иначе не поднять.
  portA = await app.get(WsGatewayService).listen(0);
  portB = await second.get(WsGatewayService).listen(0);
});

afterAll(async () => {
  await second.close();
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
  await cleanRedis(redis);
});

describe('T-023: WS-gateway, комнаты и мост pub/sub', () => {
  it('поднялись два разных инстанса', () => {
    expect(portA).toBeGreaterThan(0);
    expect(portB).toBeGreaterThan(0);
    expect(portA).not.toBe(portB);
  });

  it('DoD: событие через один инстанс получают клиенты обоих', async () => {
    const { lot } = await lotInAuction();

    const clientA = await connect(portA);
    const clientB = await connect(portB);

    try {
      clientA.send({ event: 'join_lot', lot_id: lot.id });
      clientB.send({ event: 'join_lot', lot_id: lot.id });
      await clientA.waitFor('state_snapshot');
      await clientB.waitFor('state_snapshot');

      // Ставка проходит через ядро на инстансе А и публикуется в Redis.
      const outcome = await bids.place({
        lotId: lot.id,
        bidderId: 'investor-1',
        blindCode: 'Инвестор #704',
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
      expect(outcome.status).toBe('ACCEPTED');

      // Клиент инстанса Б обязан увидеть её так же, как клиент инстанса А:
      // иначе участник, попавший на «не тот» под, не видит чужих ставок.
      const onA = await clientA.waitFor('bid_updated');
      const onB = await clientB.waitFor('bid_updated');

      expect(onA['current_price_kzt']).toBe(1_030_000);
      expect(onB).toEqual(onA);
      expect(onB['last_bidder_blind_id']).toBe('Инвестор #704');
      // Реальный id участника до клиента не доходит (FR-09).
      expect(JSON.stringify(onB)).not.toContain('investor-1');
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  it('снимок при входе отдаёт цену, шаг и остаток таймера', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);

    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      const snapshot = await client.waitFor('state_snapshot');

      expect(snapshot['lot_id']).toBe(lot.id);
      expect(snapshot['status']).toBe('RUNNING');
      expect(snapshot['current_price_kzt']).toBe(1_000_000);
      // Шаг — прибавка, next_price — абсолютная сумма для place_bid.
      expect(snapshot['bid_step_kzt']).toBe(30_000);
      expect(snapshot['next_price_kzt']).toBe(1_030_000);
      expect(snapshot['seq']).toBe(0);
      expect(snapshot['time_remaining_ms']).toBeGreaterThan(45_000);
      // Абсолютного дедлайна клиенту не выдаём — только остаток.
      expect(Object.keys(snapshot)).not.toContain('deadline_ms');
    } finally {
      client.close();
    }
  });

  it('повторный join идемпотентен и присылает свежий снимок', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);
    const rooms = app.get(WsGatewayService);

    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      await client.waitFor('state_snapshot');

      await bids.place({
        lotId: lot.id,
        bidderId: 'investor-1',
        blindCode: 'Инвестор #100',
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
      await client.waitFor('bid_updated');

      // На этом стоит ресинк после обрыва связи (T-030).
      client.messages.length = 0;
      client.send({ event: 'join_lot', lot_id: lot.id });
      const again = await client.waitFor('state_snapshot');

      expect(again['current_price_kzt']).toBe(1_030_000);
      expect(again['seq']).toBe(1);
      expect(rooms.connectionCount()).toBe(1);
    } finally {
      client.close();
    }
  });

  it('после leave_lot события не приходят', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);

    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      await client.waitFor('state_snapshot');

      client.send({ event: 'leave_lot', lot_id: lot.id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      client.messages.length = 0;

      await bids.place({
        lotId: lot.id,
        bidderId: 'investor-1',
        blindCode: 'Инвестор #100',
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(client.messages.filter((m) => m['event'] === 'bid_updated')).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it('битый токен — отказ, а не молчаливый вход гостем', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);

    try {
      // Иначе участник с истёкшим токеном смотрел бы торги как аноним и узнал
      // бы об этом в момент, когда ставка не проходит.
      client.send({ event: 'join_lot', lot_id: lot.id, token: 'not-a-token' });
      const error = await client.waitFor('error');
      expect(error['code']).toBe('INVALID_TOKEN');
    } finally {
      client.close();
    }
  });

  it('вход с действующим токеном разрешён', async () => {
    const { lot } = await lotInAuction();
    const investor = await devLogin(['INVESTOR']);
    const client = await connect(portA);

    try {
      client.send({ event: 'join_lot', lot_id: lot.id, token: investor.accessToken });
      const snapshot = await client.waitFor('state_snapshot');
      expect(snapshot['lot_id']).toBe(lot.id);
    } finally {
      client.close();
    }
  });

  it('в комнату лота без торгов не пускают', async () => {
    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: crypto.randomUUID() });
      const error = await client.waitFor('error');
      expect(error['code']).toBe('SESSION_NOT_FOUND');
    } finally {
      client.close();
    }
  });

  it('мусор и лишние поля отклоняются', async () => {
    const client = await connect(portA);
    try {
      // Не JSON.
      client.socket.send('не-джейсон');
      expect((await client.waitFor('error'))['code']).toBe('BAD_MESSAGE');

      // Лишнее поле: .strict() на схеме — аналог forbidNonWhitelisted (QA-04).
      client.messages.length = 0;
      client.send({ event: 'join_lot', lot_id: crypto.randomUUID(), hack: 1 });
      expect((await client.waitFor('error'))['code']).toBe('BAD_MESSAGE');

      // Неизвестное событие.
      client.messages.length = 0;
      client.send({ event: 'place_bid', lot_id: crypto.randomUUID() });
      expect((await client.waitFor('error'))['code']).toBe('BAD_MESSAGE');
    } finally {
      client.close();
    }
  });

  it('DoD T-026: остаток таймера на двух инстансах расходится не больше чем на тик', async () => {
    const { lot } = await lotInAuction();
    const clientA = await connect(portA);
    const clientB = await connect(portB);

    try {
      clientA.send({ event: 'join_lot', lot_id: lot.id });
      clientB.send({ event: 'join_lot', lot_id: lot.id });
      await clientA.waitFor('state_snapshot');
      await clientB.waitFor('state_snapshot');

      // Три секунды — три тика на каждом инстансе.
      await new Promise((resolve) => setTimeout(resolve, 3_200));

      const ticksA = clientA.messages.filter((m) => m['event'] === 'timer_tick');
      const ticksB = clientB.messages.filter((m) => m['event'] === 'timer_tick');
      expect(ticksA.length).toBeGreaterThanOrEqual(2);
      expect(ticksB.length).toBeGreaterThanOrEqual(2);

      // Оба инстанса вещают из одного авторитетного дедлайна, поэтому
      // расходиться могут только фазы тиков — меньше чем на один период.
      const lastA = ticksA[ticksA.length - 1] as Record<string, number>;
      const lastB = ticksB[ticksB.length - 1] as Record<string, number>;
      const drift = Math.abs((lastA['time_remaining_ms'] ?? 0) - (lastB['time_remaining_ms'] ?? 0));
      expect(drift).toBeLessThanOrEqual(1_100);

      // Остаток убывает и никогда не уходит в минус.
      const firstA = ticksA[0] as Record<string, number>;
      expect(lastA['time_remaining_ms']).toBeLessThan(firstA['time_remaining_ms'] ?? 0);
      for (const tick of [...ticksA, ...ticksB]) {
        expect(tick['time_remaining_ms']).toBeGreaterThanOrEqual(0);
      }

      // Часы клиента не участвуют: абсолютного дедлайна в кадре нет вовсе,
      // есть готовый остаток и серверная метка времени.
      expect(Object.keys(lastA)).toEqual(
        expect.arrayContaining(['time_remaining_ms', 'server_ts', 'lot_id', 'seq']),
      );
      expect(Object.keys(lastA)).not.toContain('deadline_ms');
      expect(Object.keys(lastA)).not.toContain('deadline_at');
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  it('принятая ставка сдвигает остаток обратно к пятидесяти секундам', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);

    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      await client.waitFor('state_snapshot');
      await new Promise((resolve) => setTimeout(resolve, 2_200));

      const before = client.messages.filter((m) => m['event'] === 'timer_tick').pop() as Record<
        string,
        number
      >;
      expect(before['time_remaining_ms']).toBeLessThan(49_000);

      await bids.place({
        lotId: lot.id,
        bidderId: 'investor-1',
        blindCode: 'Инвестор #100',
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
      await client.waitFor('bid_updated');

      client.messages.length = 0;
      const after = await client.waitFor('timer_tick');
      expect(after['time_remaining_ms']).toBeGreaterThan(48_000);
      expect(after['seq']).toBe(1);
    } finally {
      client.close();
    }
  });

  it('тики не идут в комнату, из которой все вышли', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);

    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      await client.waitFor('state_snapshot');
      await client.waitFor('timer_tick');

      client.send({ event: 'leave_lot', lot_id: lot.id });
      await new Promise((resolve) => setTimeout(resolve, 300));
      client.messages.length = 0;

      // Пустая комната закрывается — вещать некому и незачем.
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(client.messages.filter((m) => m['event'] === 'timer_tick')).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it('DoD T-030: после десятисекундного обрыва остаток верен в пределах тика', async () => {
    const { lot } = await lotInAuction();
    const investor = await investorId();
    const first = await connect(portA);

    let beforeDrop: number;
    try {
      first.send({ event: 'join_lot', lot_id: lot.id });
      const snapshot = await first.waitFor('state_snapshot');
      beforeDrop = snapshot['time_remaining_ms'] as number;

      await bids.place({
        lotId: lot.id,
        bidderId: investor,
        blindCode: 'Инвестор #704',
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
      await first.waitFor('bid_updated');
      // Лента читается из PostgreSQL: в проде туда переносит воркер, здесь — вручную.
      await outbox.drain();
    } finally {
      // Обрыв: сокет рвётся без прощания, как при пропаже сети.
      first.socket.terminate();
    }

    // Десять секунд без связи. Клиент в это время не считает ничего — у него
    // нет и не может быть собственного отсчёта.
    const droppedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const offlineMs = Date.now() - droppedAt;

    const second = await connect(portA);
    try {
      second.send({ event: 'join_lot', lot_id: lot.id });
      const resynced = await second.waitFor('state_snapshot');
      const remaining = resynced['time_remaining_ms'] as number;

      /**
       * Главное утверждение приёмки: остаток учитывает всё время, что связи не
       * было. Клиент, продолживший считать свой таймер, показал бы почти
       * полные пятьдесят секунд и позволил бы человеку думать, что у него есть
       * время, которого нет.
       *
       * Допуск — один тик плюс запас на дорогу: ставка перед обрывом сбросила
       * таймер, значит от неё прошло примерно offlineMs.
       */
      const expected = SMART_HAMMER_TIMER_MS - offlineMs;
      expect(Math.abs(remaining - expected)).toBeLessThanOrEqual(1_500);
      expect(remaining).toBeLessThan(beforeDrop);

      // Пропущенное видно сразу, без отдельного запроса за историей.
      const tail = resynced['recent_bids'] as Record<string, unknown>[];
      expect(tail).toHaveLength(1);
      expect(tail[0]?.['seq']).toBe(1);
      expect(tail[0]?.['last_bidder_blind_id']).toBe('Инвестор #704');
      expect(resynced['seq']).toBe(1);
      expect(resynced['current_price_kzt']).toBe(1_030_000);

      // Тики продолжают идти в новое соединение.
      const tick = await second.waitFor('timer_tick', 3_000);
      expect(tick['time_remaining_ms']).toBeLessThanOrEqual(remaining);
    } finally {
      second.close();
    }
  }, 60_000);

  it('снимок при входе несёт хвост ленты, а не пустоту', async () => {
    const { lot } = await lotInAuction();
    const [one, two] = [await investorId(), await investorId()];
    for (const bidder of [one, two, one]) {
      await bids.place({
        lotId: lot.id,
        bidderId: bidder,
        blindCode: `Инвестор #${bidder === one ? '100' : '200'}`,
        expectedAmountTiyn: await bids.nextPriceTiyn(lot.id),
      });
    }
    await outbox.drain();

    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      const snapshot = await client.waitFor('state_snapshot');
      const tail = snapshot['recent_bids'] as Record<string, unknown>[];

      // Свежие сверху — лента читается сверху вниз.
      expect(tail.map((bid) => bid['seq'])).toEqual([3, 2, 1]);
      // Реальных участников в хвосте нет (FR-09).
      expect(JSON.stringify(tail)).not.toContain(one);
    } finally {
      client.close();
    }
  });

  /**
   * Ставка по сокету (ТЗ §2.1, FR-04).
   *
   * До этого ядро ставки существовало без транспорта: кнопке «Сделать ставку»
   * было некуда нажимать. Gateway здесь только транспорт — проверки и цена
   * живут в одном пути ставки, общем для любого входа.
   */
  async function bidder(lotId: string): Promise<{ tokens: TokenPair; id: string }> {
    const tokens = await egovLogin(randomIin());
    const id = await userId(tokens);
    const payments = app.get(DepositPaymentsService);
    const bank = app.get(BankMockProvider);
    await payments.requestPayment({ lotId, userId: id });
    const deposit = await prisma.deposit.findFirstOrThrow({ where: { lotId, userId: id } });
    await payments.handleWebhook(bank.emitPayment(deposit.id, deposit.amountTiyn));
    return { tokens, id };
  }

  it('place_bid по сокету принимается и доходит до соседей', async () => {
    const { lot } = await lotInAuction();
    const investor = await bidder(lot.id);

    const client = await connect(portA);
    const watcher = await connect(portB);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id, token: investor.tokens.accessToken });
      watcher.send({ event: 'join_lot', lot_id: lot.id });
      const snapshot = await client.waitFor('state_snapshot');
      await watcher.waitFor('state_snapshot');

      // Ставим ровно ту сумму, что показана на кнопке.
      client.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: snapshot['next_price_kzt'] });

      const accepted = await client.waitFor('bid_accepted');
      expect(accepted['current_price_kzt']).toBe(snapshot['next_price_kzt']);
      expect(accepted['seq']).toBe(1);

      // Остальным про ставку сообщает bid_updated, а не личный ответ.
      const updated = await watcher.waitFor('bid_updated');
      expect(updated['current_price_kzt']).toBe(snapshot['next_price_kzt']);
      expect(JSON.stringify(updated)).not.toContain(investor.id);
    } finally {
      client.close();
      watcher.close();
    }
  });

  it('браузер ставит по куке, без токена в JavaScript', async () => {
    const { lot } = await lotInAuction();
    const investor = await bidder(lot.id);

    // Кука приходит с рукопожатием — ровно так её пришлёт браузер.
    const client = await connect(portA, `auction_at=${investor.tokens.accessToken}`);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      const snapshot = await client.waitFor('state_snapshot');
      client.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: snapshot['next_price_kzt'] });
      await client.waitFor('bid_accepted');
    } finally {
      client.close();
    }
  });

  it('без входа ставку не принимают', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      const snapshot = await client.waitFor('state_snapshot');

      client.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: snapshot['next_price_kzt'] });
      const error = await client.waitFor('error');
      expect(error['code']).toBe('INVALID_TOKEN');
    } finally {
      client.close();
    }
  });

  it('ставка в лот, за которым не следишь, отклоняется', async () => {
    const { lot } = await lotInAuction();
    const investor = await bidder(lot.id);
    const other = await lotInAuction();

    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: other.lot.id, token: investor.tokens.accessToken });
      await client.waitFor('state_snapshot');

      // Участник обязан видеть цену и таймер, на которые ставит.
      client.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: 1_030_000 });
      const error = await client.waitFor('error');
      expect(error['code']).toBe('SESSION_NOT_FOUND');
    } finally {
      client.close();
    }
  });

  it('чужая сумма отклоняется как PRICE_MISMATCH', async () => {
    const { lot } = await lotInAuction();
    const investor = await bidder(lot.id);

    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id, token: investor.tokens.accessToken });
      const snapshot = await client.waitFor('state_snapshot');

      // Сумму назначает сервер; присланная — только сверка (QA-04).
      client.send({
        event: 'place_bid',
        lot_id: lot.id,
        amount_kzt: Number(snapshot['next_price_kzt']) + 1,
      });
      const rejected = await client.waitFor('bid_rejected');
      expect(rejected['code']).toBe('PRICE_MISMATCH');

      // Отказ называет цену: без неё кнопка осталась бы с суммой, которую
      // сервер не примет, и участник узнал бы правду только из общего события.
      expect(rejected['current_price_kzt']).toBe(snapshot['current_price_kzt']);
      expect(rejected['next_price_kzt']).toBe(snapshot['next_price_kzt']);
      expect(rejected['seq']).toBe(0);
    } finally {
      client.close();
    }
  });

  it('DoD T-052: проигравший в гонке узнаёт актуальную цену из самого отказа', async () => {
    const { lot } = await lotInAuction();
    const winner = await bidder(lot.id);
    const loser = await bidder(lot.id);

    const first = await connect(portA);
    const second = await connect(portB);
    try {
      first.send({ event: 'join_lot', lot_id: lot.id, token: winner.tokens.accessToken });
      second.send({ event: 'join_lot', lot_id: lot.id, token: loser.tokens.accessToken });
      const snapshot = await first.waitFor('state_snapshot');
      await second.waitFor('state_snapshot');

      const contested = Number(snapshot['next_price_kzt']);
      first.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: contested });
      await first.waitFor('bid_accepted');

      // Пауза — не борьба с нестабильностью, а само правило FR-10: не чаще
      // одной ставки в 500 мс на адрес, а оба участника здесь с 127.0.0.1.
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Второй посылает ту же сумму: он отправил её до того, как узнал о первой
      // ставке. Ровно так выглядит гонка за лот со стороны проигравшего.
      second.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: contested });
      const rejected = await second.waitFor('bid_rejected');

      expect(rejected['code']).toBe('PRICE_MISMATCH');
      // Цена, которую он назвал, теперь текущая, а ставить нужно на шаг выше.
      expect(rejected['current_price_kzt']).toBe(contested);
      expect(rejected['next_price_kzt']).toBe(Math.round(contested * 1.03));
      expect(rejected['seq']).toBe(1);
      // Псевдоним победителя в личный отказ не попадает: кто именно перебил —
      // не дело проигравшего, это узнаётся из ленты (FR-09).
      expect(JSON.stringify(rejected)).not.toContain(winner.id);
    } finally {
      first.close();
      second.close();
    }
  });

  /**
   * Метрики приёмки (T-053, NFR-02/NFR-03).
   *
   * Проверяется не «метрика существует», а что она наполняется настоящей
   * работой: ставкой по сокету, вещанием в комнату, ответом на ping. Метрика,
   * которую никто не наполняет, на дашборде выглядит как «всё спокойно» —
   * и это худший вид неверных данных.
   */
  it('DoD T-053: метрики видят ставку, вещание и качество связи', async () => {
    const { lot } = await lotInAuction();
    const investor = await bidder(lot.id);
    const metrics = app.get(MetricsService);

    // Значения до: файл прогоняет ставки и в других тестах, поэтому сравниваем
    // приращение, а не абсолют.
    const before = await counters(metrics);

    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id, token: investor.tokens.accessToken });
      const snapshot = await client.waitFor('state_snapshot');
      client.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: snapshot['next_price_kzt'] });
      await client.waitFor('bid_accepted');

      // Ждём такт heartbeat: ping идёт раз в 2 с (ТЗ §2.2), и до его ответа
      // задержку связи никто не измерял. Тик придёт раньше — он раз в секунду.
      await client.waitFor('timer_tick');
      await new Promise((resolve) => setTimeout(resolve, 2_300));

      const after = await counters(metrics);
      const { body } = await metrics.scrape();

      // Полный серверный путь ставки — та величина, которую приёмка сверяет с
      // ≤15 мс (NFR-02, ОВ-2).
      expect(after.bidsAccepted - before.bidsAccepted).toBe(1);
      expect(after.bidObservations - before.bidObservations).toBe(1);
      // Ядро замерено отдельно: без этого не отличить «медленный Lua» от
      // «медленной проверки прав» (найдено на T-051).
      expect(after.coreObservations - before.coreObservations).toBe(1);
      // Вещание — время постановки в отправку, как его определяет ОВ-2.
      expect(after.broadcasts - before.broadcasts).toBeGreaterThan(0);
      // Качество связи: ответ на ping пришёл и попал в гистограмму.
      expect(after.rttObservations - before.rttObservations).toBeGreaterThan(0);

      // Размеры комнат снимаются тактом heartbeat.
      expect(after.connections).toBeGreaterThan(0);
      expect(after.largestRoom).toBeGreaterThan(0);

      /**
       * Бакет ровно на пороге обязателен.
       *
       * `histogram_quantile` интерполирует ВНУТРИ бакета, поэтому без границы
       * на 0.015 приёмка сверяла бы p99 с приблизительным числом, а алерт
       * срабатывал бы не там, где порог. То же с 0.005 для вещания и 2 для
       * задержки связи (порог SLA Freeze).
       */
      expect(body).toContain('auction_bid_duration_seconds_bucket{le="0.015"');
      expect(body).toContain('auction_broadcast_duration_seconds_bucket{le="0.005"');
      expect(body).toContain('auction_heartbeat_rtt_seconds_bucket{le="2"');

      // Метки лота нет ни у одной метрики: лотов десятки тысяч, и серия на
      // каждый — это разрыв Prometheus, а не наблюдаемость.
      expect(body).not.toContain(lot.id);

      // Задержка event loop — ею объясняются спорные финиши торгов (R-5).
      expect(body).toContain('nodejs_eventloop_lag_seconds');
    } finally {
      client.close();
    }
  });

  it('метрики отдаются на своём порту, а не в /api', async () => {
    const port = await app.get(MetricsServer).listen(0);

    const scrape = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get('content-type')).toContain('text/plain');
    expect(await scrape.text()).toContain('auction_bid_duration_seconds');

    // Ничего, кроме /metrics, этот порт не отдаёт: он не для людей.
    expect((await fetch(`http://127.0.0.1:${String(port)}/`)).status).toBe(404);

    // Того же в API нет: ingress публикует весь /api наружу, и метрики
    // оказались бы в интернете (T-053).
    await api().get('/api/metrics').expect(404);
  });

  it('лишнее поле в ставке — отказ, а не выброшенный ключ', async () => {
    const { lot } = await lotInAuction();
    const client = await connect(portA);
    try {
      client.send({ event: 'join_lot', lot_id: lot.id });
      await client.waitFor('state_snapshot');
      client.send({ event: 'place_bid', lot_id: lot.id, amount_kzt: 1_030_000, blind_id: 'я' });
      const error = await client.waitFor('error');
      expect(error['code']).toBe('BAD_MESSAGE');
    } finally {
      client.close();
    }
  });

  it('проба живости отвечает на обоих инстансах', async () => {
    for (const port of [portA, portB]) {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status']).toBe('up');
      expect(typeof body['connections']).toBe('number');
    }
  });
});
