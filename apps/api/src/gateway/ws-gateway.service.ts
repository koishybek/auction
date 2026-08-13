import { createServer, type Server } from 'node:http';

import type {
  BidUpdatedEvent,
  StateSnapshotEvent,
  TimerTickEvent,
  WsErrorCode,
} from '@auction/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, type WebSocket } from 'ws';

import { AuctionStateService } from '../auction/auction-state.service';
import { AuctionService } from '../auction/auction.service';
import { TokenService } from '../auth/token.service';
import type { Env } from '../config/env.schema';
import { TimeService } from '../time/time.service';

import { parseClientMessage } from './gateway.protocol';
import { LotRoomsService, type RoomMember } from './lot-rooms.service';

/**
 * Кадр длиннее этого не разбирается. Наши сообщения — десятки байт; всё
 * остальное либо ошибка клиента, либо попытка занять gateway разбором JSON.
 */
const MAX_FRAME_BYTES = 4 * 1024;

/** Как часто проверяется живость соединения. */
const HEARTBEAT_MS = 15_000;

/**
 * Период тика таймера. 1000 мс задано ТЗ §2.1 и FR-02 — не настройка.
 *
 * Тикает каждый инстанс по своим комнатам: координировать их незачем, значение
 * всё равно берётся с часов Redis. Разъехаться могут только фазы тиков — на
 * величину меньше одного периода, что DoD и допускает.
 */
const TIMER_TICK_MS = 1_000;

/**
 * Сколько комнат может держать одно соединение. Смотреть десяток лотов
 * одновременно — нормально, тысячу — способ раздуть память gateway с одного
 * сокета.
 */
const MAX_ROOMS_PER_SOCKET = 20;

/**
 * Сколько последних ставок кладётся в снимок состояния.
 *
 * Хвост, а не история: вернувшемуся после обрыва нужно понять, что произошло,
 * а не выгрузить сессию целиком. За полной лентой есть отдельная ручка.
 */
const SNAPSHOT_BIDS = 10;

/** Состояние соединения, которое держит сам gateway. */
interface Connection extends RoomMember {
  readonly socket: WebSocket;
  userId: string | null;
  /** Ответил ли на последний ping. Не ответил дважды — соединение мертво. */
  alive: boolean;
  rooms: Set<string>;
}

/**
 * WebSocket-gateway торгов (T-023).
 *
 * Stateless по построению: всё, что он помнит, — какие соединения в каких
 * комнатах. Ни цены, ни дедлайна, ни истории он не хранит; авторитет — Redis.
 * Поэтому инстансы взаимозаменяемы, балансировщику не нужны sticky-сессии, а
 * упавший gateway не уносит с собой торги.
 */
@Injectable()
export class WsGatewayService implements OnModuleDestroy {
  private readonly logger = new Logger(WsGatewayService.name);
  private readonly connections = new Set<Connection>();
  private readonly defaultPort: number;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(
    private readonly rooms: LotRoomsService,
    private readonly auction: AuctionService,
    private readonly state: AuctionStateService,
    private readonly tokens: TokenService,
    private readonly time: TimeService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultPort = config.get('GATEWAY_PORT', { infer: true });
  }

  /**
   * Поднять сервер.
   *
   * Порт передаётся аргументом, а не берётся из конфига внутри: два инстанса
   * в одном процессе — это ровно та проверка, которую требует DoD, и без
   * явного порта её не поставить.
   */
  async listen(port: number = this.defaultPort): Promise<number> {
    const http = createServer((request, response) => {
      // Проба живости для Kubernetes: у gateway нет REST, а под без проверки
      // считается живым, пока процесс существует, — даже если сокеты не берёт.
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'up',
            connections: this.connections.size,
            rooms: this.rooms.roomCount(),
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });

    const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES });
    wss.on('connection', (socket: WebSocket) => {
      this.onConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, () => {
        resolve();
      });
    });

    this.http = http;
    this.wss = wss;
    this.heartbeat = setInterval(() => {
      this.sweep();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();

    this.ticker = setInterval(() => {
      void this.broadcastTimers().catch((error: unknown) => {
        // Пропущенный тик — не повод ронять gateway: следующий придёт через
        // секунду, а клиент и так знает, что остаток убывает.
        this.logger.warn(
          `Тик таймера не отправлен: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, TIMER_TICK_MS);
    this.ticker.unref();

    const actual = addressPort(http) ?? port;
    this.logger.log(`WS-gateway слушает :${String(actual)}`);
    return actual;
  }

  /** Сколько соединений держит инстанс. Для метрик и тестов. */
  connectionCount(): number {
    return this.connections.size;
  }

  private onConnection(socket: WebSocket): void {
    const connection: Connection = {
      id: `ws-${String(this.nextId)}`,
      socket,
      userId: null,
      alive: true,
      rooms: new Set<string>(),
      send: (payload: string) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      },
    };
    this.nextId += 1;
    this.connections.add(connection);

    socket.on('message', (data: unknown) => {
      void this.onMessage(connection, String(data));
    });
    socket.on('close', () => {
      void this.onClose(connection);
    });
    socket.on('error', (error: Error) => {
      this.logger.warn(`Соединение ${connection.id}: ${error.message}`);
    });
  }

  private async onMessage(connection: Connection, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw, MAX_FRAME_BYTES);
    if (!parsed.ok) {
      this.fail(connection, 'BAD_MESSAGE', parsed.reason);
      return;
    }

    const message = parsed.message;
    if (message.event === 'pong') {
      connection.alive = true;
      return;
    }
    if (message.event === 'leave_lot') {
      connection.rooms.delete(message.lot_id);
      await this.rooms.leave(message.lot_id, connection);
      return;
    }

    await this.onJoin(connection, message.lot_id, message.token);
  }

  private async onJoin(
    connection: Connection,
    lotId: string,
    token: string | undefined,
  ): Promise<void> {
    if (token !== undefined) {
      try {
        connection.userId = this.tokens.verifyAccess(token).sub;
      } catch {
        // Не «считаем гостем»: иначе участник с истёкшим токеном смотрел бы
        // торги как аноним и узнал бы об этом в момент отказа ставки.
        this.fail(connection, 'INVALID_TOKEN', 'Токен недействителен или истёк');
        return;
      }
    }

    if (!connection.rooms.has(lotId) && connection.rooms.size >= MAX_ROOMS_PER_SOCKET) {
      this.fail(connection, 'TOO_MANY_ROOMS', `Не больше ${String(MAX_ROOMS_PER_SOCKET)} лотов`);
      return;
    }

    let snapshot: StateSnapshotEvent;
    try {
      const [state, recentBids] = await Promise.all([
        this.auction.snapshot(lotId),
        this.auction.history(lotId, SNAPSHOT_BIDS),
      ]);
      snapshot = toSnapshotEvent(state, recentBids);
    } catch {
      this.fail(connection, 'SESSION_NOT_FOUND', 'По этому лоту торги не идут');
      return;
    }

    // Вход идемпотентен: повторный join присылает свежий снимок и не плодит
    // подписок. На этом стоит ресинк после обрыва связи (T-030).
    if (!connection.rooms.has(lotId)) {
      connection.rooms.add(lotId);
      await this.rooms.join(lotId, connection);
    }
    connection.send(JSON.stringify(snapshot));
  }

  private async onClose(connection: Connection): Promise<void> {
    this.connections.delete(connection);
    connection.rooms.clear();
    await this.rooms.leaveAll(connection);
  }

  /**
   * Разослать остаток таймера во все свои комнаты (T-026).
   *
   * Остаток берётся из авторитетного дедлайна в Redis и считается там же —
   * клиент получает готовое число и никогда не считает его сам. Локальный
   * обратный отсчёт в браузере разошёлся бы с сервером на дрейф часов и на
   * задержку вкладки в фоне, а на пятидесяти секундах это решает исход торгов.
   *
   * Один запрос на тик независимо от числа комнат: сто активных лотов не
   * должны означать сто обращений в Redis каждую секунду с каждого инстанса.
   */
  private async broadcastTimers(): Promise<void> {
    const lotIds = this.rooms.activeLots();
    if (lotIds.length === 0) {
      return;
    }

    for (const timer of await this.state.readTimers(lotIds)) {
      const tick: TimerTickEvent = {
        event: 'timer_tick',
        lot_id: timer.lotId,
        time_remaining_ms: timer.timeRemainingMs,
        server_ts: timer.nowMs,
        seq: timer.seq,
      };
      this.rooms.broadcast(timer.lotId, JSON.stringify(tick));
    }
  }

  /** Разослать ping и закрыть тех, кто не ответил на предыдущий. */
  private sweep(): void {
    const ping = JSON.stringify({ event: 'ping', server_ts: this.time.wallClockMs() });
    for (const connection of this.connections) {
      if (!connection.alive) {
        // Молчащее соединение занимает память и получает события, которых
        // никто не видит. Закрываем — клиент переподключится и заберёт снимок.
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.send(ping);
    }
  }

  private fail(connection: Connection, code: WsErrorCode, message: string): void {
    connection.send(JSON.stringify({ event: 'error', code, message }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    this.connections.clear();

    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;

    if (wss !== null) {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    }
    if (http !== null) {
      await new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
      });
    }
  }
}

/** Состояние из REST-формы в форму провода WebSocket (ТЗ §2.1: snake_case, тенге). */
function toSnapshotEvent(
  state: {
    lotId: string;
    sessionId: string;
    status: 'RUNNING' | 'FROZEN' | 'FINISHED';
    currentPriceTenge: number;
    nextBidTenge: number;
    timeRemainingMs: number;
    serverTs: number;
    seq: number;
  },
  recentBids: readonly BidUpdatedEvent[],
): StateSnapshotEvent {
  return {
    recent_bids: recentBids,
    event: 'state_snapshot',
    lot_id: state.lotId,
    session_id: state.sessionId,
    status: state.status,
    current_price_kzt: state.currentPriceTenge,
    bid_step_kzt: state.nextBidTenge - state.currentPriceTenge,
    next_price_kzt: state.nextBidTenge,
    time_remaining_ms: state.timeRemainingMs,
    server_ts: state.serverTs,
    seq: state.seq,
  };
}

/** Фактический порт: при port=0 ОС выбирает свободный, и знать его нужно тесту. */
function addressPort(server: Server): number | null {
  const address = server.address();
  return address !== null && typeof address === 'object' ? address.port : null;
}
