import { createServer, type IncomingMessage, type Server } from 'node:http';

import type {
  PointerKind,
  BidAcceptedEvent,
  BidRejectedEvent,
  BidUpdatedEvent,
  StateSnapshotEvent,
  TimerTickEvent,
  WsErrorCode,
} from '@auction/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { AuctionStateService } from '../auction/auction-state.service';
import { AuctionService } from '../auction/auction.service';
import { BidPlacementService } from '../auction/bid-placement.service';
import { isDegradedLink, SlaFreezeService } from '../auction/sla-freeze.service';
import { ACCESS_COOKIE, cookieValue } from '../auth/session-cookies';
import { clientIpFrom } from '../common/http/client-ip';
import { TokenService } from '../auth/token.service';
import type { Env } from '../config/env.schema';
import { MetricsService } from '../metrics/metrics.service';
import { TimeService } from '../time/time.service';

import { parseClientMessage } from './gateway.protocol';
import { LotRoomsService, type RoomMember } from './lot-rooms.service';

/**
 * Кадр длиннее этого не разбирается. Наши сообщения — десятки байт; всё
 * остальное либо ошибка клиента, либо попытка занять gateway разбором JSON.
 */
const MAX_FRAME_BYTES = 4 * 1024;

/**
 * Период ping. 2000 мс задано ТЗ §2.2 — на этом же такте считается деградация
 * связи для SLA Freeze, поэтому значение не произвольное.
 */
const HEARTBEAT_MS = 2_000;

/**
 * Сколько тактов без ответа терпим, прежде чем закрыть соединение.
 *
 * Раньше ping шёл раз в 15 секунд и одного пропуска хватало. Теперь такт 2
 * секунды, и рвать связь после одного пропущенного ответа значило бы
 * выбрасывать людей при первой же икоте сети — той самой, ради которой
 * существует SLA Freeze.
 */
const MISSED_PONGS_BEFORE_DROP = 5;

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
  /** Адрес клиента: на нём держится лимит частоты ставок (FR-10). */
  readonly ip: string | null;
  /** Сколько тактов подряд не ответил на ping. */
  missedPongs: number;
  /** Когда отправлен последний ping. */
  pingSentAt: number | null;
  /**
   * Когда отправлен САМЫЙ РАННИЙ ping без ответа — от него считается задержка.
   *
   * Отдельно от `pingSentAt` не для порядка: такт heartbeat — 2 с, а порог
   * деградации ровно 2 с (ТЗ §2.2). Ответ на медленном канале приходит уже
   * после того, как ушёл следующий ping, и задержка, посчитанная от него,
   * выходит меньше настоящей на целый такт. Клиент с реальными 2.5 с выглядел
   * при этом на 0.5 с — то есть здоровым, и заморозка не наступала именно в том
   * случае, ради которого написана.
   */
  pendingPingAt: number | null;
  /** Задержка последнего ответа, мс. null — ответа ещё не было. */
  rttMs: number | null;
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
  private readonly trustProxyHops: number;
  private readonly trustCloudflareIp: boolean;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(
    private readonly rooms: LotRoomsService,
    private readonly auction: AuctionService,
    private readonly state: AuctionStateService,
    private readonly slaFreeze: SlaFreezeService,
    private readonly bidPlacement: BidPlacementService,
    private readonly tokens: TokenService,
    private readonly time: TimeService,
    private readonly metrics: MetricsService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultPort = config.get('GATEWAY_PORT', { infer: true });
    this.trustProxyHops = config.get('TRUST_PROXY_HOPS', { infer: true });
    this.trustCloudflareIp = config.get('TRUST_CLOUDFLARE_IP', { infer: true });
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
    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      this.onConnection(socket, request);
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

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const connection: Connection = {
      id: `ws-${String(this.nextId)}`,
      socket,
      // Браузер предъявляет себя кукой при рукопожатии: токена в JavaScript у
      // него нет и быть не должно. Служебные клиенты по-прежнему могут прислать
      // токен в join_lot.
      userId: this.userFromCookie(request),
      ip: clientIp(request, this.trustProxyHops, this.trustCloudflareIp),
      missedPongs: 0,
      pingSentAt: null,
      pendingPingAt: null,
      rttMs: null,
      rooms: new Set<string>(),
      send: (payload: string) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      },
      // По этому признаку комната отличает участника, ушедшего во время
      // подписки на канал, от живого (см. LotRoomsService.join).
      isAlive: () => socket.readyState === socket.OPEN,
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
      // Задержка ответа — единственная метрика качества связи, которая у нас
      // есть: клиент ничего не измеряет и ничего не присылает, кроме факта.
      // Считаем от САМОГО РАННЕГО неотвеченного ping, а не от последнего: на
      // медленном канале ответ приходит уже после следующего такта, и от
      // последнего задержка выходит меньше настоящей ровно на такт.
      const sentAt = connection.pendingPingAt ?? connection.pingSentAt;
      if (sentAt !== null) {
        connection.rttMs = this.time.wallClockMs() - sentAt;
        // Та же величина уходит в метрику: по ней строится доля деградировавших
        // клиентов, а она предсказывает SLA Freeze раньше, чем он случится.
        this.metrics.observeHeartbeatRtt(connection.rttMs / 1000);
      }
      connection.pendingPingAt = null;
      connection.missedPongs = 0;
      return;
    }
    if (message.event === 'leave_lot') {
      connection.rooms.delete(message.lot_id);
      await this.rooms.leave(message.lot_id, connection);
      return;
    }
    if (message.event === 'place_bid') {
      await this.onPlaceBid(connection, message.lot_id, message.amount_kzt, message.behavior);
      return;
    }

    await this.onJoin(connection, message.lot_id, message.token);
  }

  /**
   * Ставка (ТЗ §2.1, FR-04).
   *
   * Gateway здесь только транспорт: он не считает цену, не проверяет права и
   * не трогает таймер. Всё это делает путь ставки, один и тот же для любого
   * входа, — второй набор проверок рядом с денежным путём означал бы второй
   * ответ на вопрос, принята ставка или нет.
   *
   * Ответ уходит только автору. Всем остальным про принятую ставку сообщает
   * `bid_updated`, который рассылает сам Lua-скрипт через pub/sub.
   */
  private async onPlaceBid(
    connection: Connection,
    lotId: string,
    amountTenge: number,
    behavior?: {
      trusted: boolean;
      kind: PointerKind;
      moves: number;
      path_px: number;
      dwell_ms: number;
    },
  ): Promise<void> {
    if (connection.userId === null) {
      this.fail(connection, 'INVALID_TOKEN', 'Ставка требует входа');
      return;
    }
    if (!connection.rooms.has(lotId)) {
      // Ставить в лот, за которым не следишь, нельзя: участник обязан видеть
      // цену и таймер, на которые ставит.
      this.fail(connection, 'SESSION_NOT_FOUND', 'Сначала войдите в комнату лота');
      return;
    }

    const result = await this.bidPlacement.place({
      lotId,
      userId: connection.userId,
      // Тиыны из тенге: на проводе тенге, внутри системы тиыны (CLAUDE.md §4.2).
      expectedAmountTiyn: BigInt(amountTenge) * 100n,
      sessionId: connection.id,
      ip: connection.ip,
      // Снаружи snake_case по ТЗ, внутри — наш тип: конверсия на границе, как
      // и с деньгами.
      behavior:
        behavior === undefined
          ? null
          : {
              trusted: behavior.trusted,
              kind: behavior.kind,
              moves: behavior.moves,
              pathPx: behavior.path_px,
              dwellMs: behavior.dwell_ms,
            },
    });

    if (result.status === 'ACCEPTED') {
      const accepted: BidAcceptedEvent = {
        event: 'bid_accepted',
        lot_id: lotId,
        seq: result.seq,
        current_price_kzt: result.priceTenge,
      };
      connection.send(JSON.stringify(accepted));
      return;
    }

    const rejected: BidRejectedEvent = {
      event: 'bid_rejected',
      lot_id: lotId,
      code: result.code,
      ...(result.retryAfterMs === undefined ? {} : { retry_after_ms: result.retryAfterMs }),
      // Наружу тенге, внутри тиыны — конвертация уже сделана в placement.
      ...(result.live === undefined
        ? {}
        : {
            current_price_kzt: result.live.currentPriceTenge,
            next_price_kzt: result.live.nextPriceTenge,
            seq: result.live.seq,
          }),
    };
    connection.send(JSON.stringify(rejected));
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

  /**
   * Такт heartbeat: разослать ping, прибрать мёртвых, оценить деградацию.
   *
   * Отсюда же растёт SLA Freeze: задержка ответа на ping — это и есть та
   * величина, по которой ТЗ §2.2 предлагает судить о качестве связи зала.
   */
  private sweep(): void {
    const now = this.time.wallClockMs();
    const ping = JSON.stringify({ event: 'ping', server_ts: now });

    // Снимок размеров — тем же тактом, что ping. Отдельного таймера ради трёх
    // чисел не нужно, а раз в две секунды для gauge частота более чем достаточная.
    this.metrics.setGatewayGauges({
      connections: this.connections.size,
      rooms: this.rooms.roomCount(),
      largestRoom: this.rooms.largestRoom(),
    });

    /**
     * Оценка деградации идёт ДО рассылки нового ping, и это существенно.
     *
     * Проверка «ответа на ping нет дольше порога» смотрит на время отправки
     * ping. Если сначала разослать новый, время отправки станет «сейчас» — и
     * условие не выполнится ни для кого никогда, сколько бы клиент ни молчал.
     * Именно так эта проверка и была мёртвой до T-055.
     */
    void this.checkDegradation(now).catch((error: unknown) => {
      this.logger.warn(
        `Оценка деградации не удалась: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    for (const connection of this.connections) {
      if (connection.missedPongs >= MISSED_PONGS_BEFORE_DROP) {
        // Молчащее соединение занимает память и получает события, которых
        // никто не видит. Закрываем — клиент переподключится и заберёт снимок.
        connection.socket.terminate();
        continue;
      }
      connection.missedPongs += 1;
      if (connection.pendingPingAt === null) {
        connection.pendingPingAt = now;
      }
      connection.pingSentAt = now;
      connection.send(ping);
    }
  }

  /**
   * Заморозить лоты, у которых слишком много участников с плохой связью.
   *
   * ОГРАНИЧЕНИЕ, о котором нужно помнить: доля считается по клиентам ЭТОГО
   * инстанса. При нескольких gateway каждый видит только своих, и «40 %
   * подключённых» из ТЗ понимается локально. Для настоящей глобальной оценки
   * нужен общий счётчик в Redis — это следующий шаг. Ложное срабатывание при
   * этом безвредно (пауза на минуту, остаток сохранён), пропуск — нет,
   * поэтому локальная оценка лучше, чем никакой.
   */
  private async checkDegradation(now: number): Promise<void> {
    const perLot = new Map<string, { total: number; degraded: number }>();

    for (const connection of this.connections) {
      const bad = isDegradedLink({
        nowMs: now,
        pendingPingAt: connection.pendingPingAt,
        rttMs: connection.rttMs,
        missedPongs: connection.missedPongs,
      });

      for (const lotId of connection.rooms) {
        const stats = perLot.get(lotId) ?? { total: 0, degraded: 0 };
        stats.total += 1;
        if (bad) {
          stats.degraded += 1;
        }
        perLot.set(lotId, stats);
      }
    }

    for (const [lotId, stats] of perLot) {
      if (!SlaFreezeService.shouldFreeze(stats.degraded, stats.total)) {
        continue;
      }
      // Заморозка идемпотентна: замораживает только идущие торги, поэтому
      // несколько инстансов, увидевших деградацию одновременно, безопасны.
      await this.slaFreeze.freeze(
        lotId,
        `${String(stats.degraded)} из ${String(stats.total)} соединений с задержкой`,
      );
    }
  }

  /** Опознать браузер по httpOnly-куке рукопожатия. Кривая кука — просто гость. */
  private userFromCookie(request: IncomingMessage): string | null {
    const raw = request.headers.cookie;
    if (raw === undefined) {
      return null;
    }
    const token = cookieValue({ headers: { cookie: raw } } as Request, ACCESS_COOKIE);
    if (token === null) {
      return null;
    }
    try {
      return this.tokens.verifyAccess(token).sub;
    } catch {
      // В отличие от join_lot с токеном, здесь молчим: кука могла просто
      // протухнуть в открытой вкладке, и это не повод отказывать в просмотре.
      return null;
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
    resumeInMs: number | null;
    winnerBlindId: string | null;
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
    // Ключ добавляется условно, а не выставляется в undefined: при
    // exactOptionalPropertyTypes это разные вещи.
    ...(state.resumeInMs === null ? {} : { resume_in_ms: state.resumeInMs }),
    ...(state.winnerBlindId === null ? {} : { winner_blind_id: state.winnerBlindId }),
  };
}

/**
 * Адрес клиента.
 *
 * То же правило, что в API (CLAUDE.md §4.5): доверяем ровно `hops` последним
 * записям X-Forwarded-For. Заголовок дописывает кто угодно, включая самого
 * клиента, а на адресе держится лимит частоты ставок.
 */
function clientIp(request: IncomingMessage, hops: number, trustCloudflare: boolean): string | null {
  const direct = request.socket.remoteAddress ?? null;

  // За Cloudflare настоящий адрес приходит отдельным заголовком — тем же, что
  // читает REST (T-050). Один источник на оба транспорта: разъехавшись, они
  // дали бы разные адреса одному человеку в лимите и в аудите.
  const viaCloudflare = clientIpFrom(request.headers, null, trustCloudflare);
  if (viaCloudflare !== null) {
    return viaCloudflare;
  }

  if (hops <= 0) {
    return direct;
  }
  const header = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return chain[chain.length - hops] ?? direct;
}

/** Фактический порт: при port=0 ОС выбирает свободный, и знать его нужно тесту. */
function addressPort(server: Server): number | null {
  const address = server.address();
  return address !== null && typeof address === 'object' ? address.port : null;
}
