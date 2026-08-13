import type { EgovLoginResult, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { BidService } from '../src/auction/bid.service';
import { GatewayModule } from '../src/gateway/gateway.module';
import { WsGatewayService } from '../src/gateway/ws-gateway.service';
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
let portA = 0;
let portB = 0;

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

/** Клиент WS с накоплением полученных событий. */
interface Client {
  readonly socket: WebSocket;
  readonly messages: Record<string, unknown>[];
  send(message: unknown): void;
  waitFor(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
  const messages: Record<string, unknown>[] = [];

  socket.on('message', (data: unknown) => {
    messages.push(JSON.parse(String(data)) as Record<string, unknown>);
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
