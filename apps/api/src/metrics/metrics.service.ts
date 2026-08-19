import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Метрики приёмки (T-053, NFR-02/NFR-03).
 *
 * Пороги заданы не вкусом, а трактовкой ОВ-2: «≤15 мс = серверное время
 * обработки ставки; вещание ≤5 мс — время постановки в отправку». Отсюда и
 * границы бакетов: в них обязаны быть ровно пороговые значения, иначе
 * `histogram_quantile` интерполирует внутри бакета и приёмка сверяется с
 * приблизительным числом.
 *
 * Ни у одной метрики нет метки лота. Это не забывчивость: лотов десятки тысяч,
 * а серия на каждый лот — это отдельная временная серия в Prometheus на каждый
 * лот и на каждый бакет. Операционные вопросы («укладываемся ли в SLA», «не
 * растёт ли самая большая комната») отвечаются и без разбивки, а разбор
 * конкретного лота живёт в логах и audit_log, где есть его id.
 */

/**
 * Границы для серверной обработки ставки, секунды.
 *
 * 0.015 — сам порог NFR-02. Дальше редкий хвост: он нужен, чтобы отличить
 * «медленно» от «повисло», а на приёмке — чтобы p99 не упирался в +Inf.
 */
const BID_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.015, 0.025, 0.05, 0.1, 0.25, 0.5, 1] as const;

/** Границы для рассылки события в комнату, секунды. 0.005 — порог ОВ-2. */
const BROADCAST_BUCKETS = [0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.1, 0.5] as const;

/**
 * Границы для задержки ответа на ping, секунды.
 *
 * 2 — порог деградации связи, по которому считается SLA Freeze (ТЗ §2.2,
 * `DEGRADED_RTT_MS`). Без бакета ровно на нём нельзя построить алерт «доля
 * деградировавших клиентов», а именно он и предсказывает заморозку торгов.
 */
const RTT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] as const;

@Injectable()
export class MetricsService {
  /**
   * Свой реестр, а не глобальный по умолчанию.
   *
   * Глобальный — это статическое состояние процесса: e2e поднимают приложение
   * по нескольку раз в одном процессе, и второе поднятие падало бы на
   * «метрика уже зарегистрирована». Свой реестр умирает вместе с контейнером.
   */
  readonly registry = new Registry();

  /** Полный серверный путь ставки: лимит частоты, антибот, права, ядро. */
  private readonly bidDuration: Histogram<'outcome'>;

  /**
   * Только атомарное ядро (Lua) — отдельно от полного пути.
   *
   * Разделение появилось не для красоты: нагрузочный прогон T-051 показал, что
   * основной вклад дают три обращения в PostgreSQL ДО ядра. Без двух метрик
   * видно только «медленно», но не что именно оптимизировать.
   */
  private readonly bidCoreDuration: Histogram<never>;

  /** Исходы ставок. Кардинальность мала: коды перечислимы. */
  private readonly bidsTotal: Counter<'outcome' | 'code'>;

  /** Время постановки события в отправку всем в комнате (ОВ-2: ≤5 мс). */
  private readonly broadcastDuration: Histogram<'event'>;

  /** Задержка ответа на ping — качество связи зала (ТЗ §2.2). */
  private readonly heartbeatRtt: Histogram<never>;

  private readonly connections: Gauge<never>;
  private readonly rooms: Gauge<never>;
  private readonly largestRoom: Gauge<never>;

  /**
   * Перенос ставок Redis → PostgreSQL.
   *
   * Без этих четырёх чисел остановка переноса не видна ниоткуда: торги идут,
   * лента в зале живая, а в юридической записи ставок нет — и узнают об этом,
   * когда придут за протоколом. `pending` показывает, разгружается ли очередь,
   * `dead` — есть ли ставки, которые уже не запишутся сами.
   */
  private readonly outboxPending: Gauge<never>;
  private readonly outboxDead: Gauge<never>;
  private readonly outboxWritten: Counter<never>;
  private readonly outboxQuarantined: Counter<never>;

  /**
   * Торги, закрытые в Redis и не зафиксированные в PostgreSQL.
   *
   * Ненулевое значение означает лот, у которого нет ни возврата задатков, ни
   * протокола: и то и другое ищут сессию со статусом FINISHED в базе.
   */
  private readonly finishUnpersisted: Gauge<never>;

  /**
   * Доплаты, по которым счёт так и не ушёл в банк.
   *
   * Лот при этом закрыт необратимо, а победителю платить не по чему: без этого
   * числа о таком узнают от самого победителя.
   */
  private readonly paymentInvoicesMissing: Gauge<never>;

  constructor() {
    /**
     * Стандартные метрики процесса: CPU, память, GC, задержка event loop.
     *
     * Последняя здесь не «на всякий случай»: пауза event loop — это ровно тот
     * механизм, которым GC ломает таймер торгов (R-5). Без неё спорный финиш
     * нечем объяснить.
     */
    collectDefaultMetrics({ register: this.registry });

    this.bidDuration = new Histogram({
      name: 'auction_bid_duration_seconds',
      help: 'Серверная обработка ставки целиком: частота, антибот, права, ядро (NFR-02: ≤15 мс)',
      labelNames: ['outcome'],
      buckets: [...BID_BUCKETS],
      registers: [this.registry],
    });

    this.bidCoreDuration = new Histogram({
      name: 'auction_bid_core_duration_seconds',
      help: 'Атомарное ядро ставки: один вызов Lua-скрипта в Redis',
      buckets: [...BID_BUCKETS],
      registers: [this.registry],
    });

    this.bidsTotal = new Counter({
      name: 'auction_bids_total',
      help: 'Ставки по исходу. code пуст у принятых',
      labelNames: ['outcome', 'code'],
      registers: [this.registry],
    });

    this.broadcastDuration = new Histogram({
      name: 'auction_broadcast_duration_seconds',
      help: 'Постановка события в отправку всем в комнате (ОВ-2: вещание ≤5 мс)',
      labelNames: ['event'],
      buckets: [...BROADCAST_BUCKETS],
      registers: [this.registry],
    });

    this.heartbeatRtt = new Histogram({
      name: 'auction_heartbeat_rtt_seconds',
      help: 'Задержка ответа на ping: по ней считается деградация связи и SLA Freeze',
      buckets: [...RTT_BUCKETS],
      registers: [this.registry],
    });

    this.connections = new Gauge({
      name: 'auction_gateway_connections',
      help: 'Открытых WebSocket-соединений на этом инстансе gateway',
      registers: [this.registry],
    });

    this.rooms = new Gauge({
      name: 'auction_gateway_rooms',
      help: 'Комнат лотов с хотя бы одним подписчиком на этом инстансе',
      registers: [this.registry],
    });

    this.largestRoom = new Gauge({
      name: 'auction_gateway_room_connections_max',
      help: 'Соединений в самой большой комнате: по ней проверяется запас до 50 000 (NFR-03)',
      registers: [this.registry],
    });

    this.outboxPending = new Gauge({
      name: 'auction_bid_outbox_pending',
      help: 'Принятых ставок ждёт переноса в PostgreSQL: не разгружается — значит перенос встал',
      registers: [this.registry],
    });

    this.outboxDead = new Gauge({
      name: 'auction_bid_outbox_dead',
      help: 'Ставок в карантине: участники их видели, а в юридической записи их нет',
      registers: [this.registry],
    });

    this.outboxWritten = new Counter({
      name: 'auction_bid_outbox_written_total',
      help: 'Ставок перенесено в PostgreSQL',
      registers: [this.registry],
    });

    this.outboxQuarantined = new Counter({
      name: 'auction_bid_outbox_quarantined_total',
      help: 'Ставок убрано в карантин: запись не удалась и повтор её не исправит',
      registers: [this.registry],
    });

    this.finishUnpersisted = new Gauge({
      name: 'auction_finish_unpersisted',
      help: 'Торгов закрыто в Redis, но не зафиксировано в PostgreSQL: нет ни возвратов, ни протокола',
      registers: [this.registry],
    });

    this.paymentInvoicesMissing = new Gauge({
      name: 'auction_payment_invoices_missing',
      help: 'Доплат без выставленного счёта: сделка закрыта, а платить победителю не по чему',
      registers: [this.registry],
    });
  }

  /** Полный путь ставки. Секунды, потому что Prometheus меряет в секундах. */
  observeBid(input: {
    seconds: number;
    /**
     * `error` — исключение на пути ставки. Отдельным исходом, а не молчанием:
     * упавшая ставка это худшее, что может случиться с деньгами, и она обязана
     * быть видна в метрике, а не только в логах.
     */
    outcome: 'accepted' | 'rejected' | 'error';
    code: string;
  }): void {
    this.bidDuration.observe({ outcome: input.outcome }, input.seconds);
    // Метка code у принятых пустая, а не отсутствует: серия с разным набором
    // меток — это две разные серии, и суммировать их пришлось бы вручную.
    this.bidsTotal.inc({ outcome: input.outcome, code: input.code });
  }

  observeBidCore(seconds: number): void {
    this.bidCoreDuration.observe(seconds);
  }

  observeBroadcast(event: string, seconds: number): void {
    this.broadcastDuration.observe({ event }, seconds);
  }

  observeHeartbeatRtt(seconds: number): void {
    this.heartbeatRtt.observe(seconds);
  }

  /** Снимок состояния gateway. Обновляется тактом heartbeat, раз в 2 с. */
  setGatewayGauges(input: { connections: number; rooms: number; largestRoom: number }): void {
    this.connections.set(input.connections);
    this.rooms.set(input.rooms);
    this.largestRoom.set(input.largestRoom);
  }

  /** Итог одного захода переноса ставок. */
  observeOutboxDrain(input: { written: number; quarantined: number }): void {
    if (input.written > 0) {
      this.outboxWritten.inc(input.written);
    }
    if (input.quarantined > 0) {
      this.outboxQuarantined.inc(input.quarantined);
    }
  }

  /**
   * Глубина очереди переноса. Обновляется реже, чем идёт разбор.
   *
   * Считается вне захода, поэтому у здорового переноса читается ноль:
   * подтверждение идёт сразу за записью. Ненулевое значение, которое не
   * обнуляется, и есть признак остановки.
   */
  setOutboxDepth(input: { pending: number; dead: number }): void {
    this.outboxPending.set(input.pending);
    this.outboxDead.set(input.dead);
  }

  /** Сколько закрытых лотов ждут фиксации в PostgreSQL. Норма — ноль. */
  setFinishUnpersisted(count: number): void {
    this.finishUnpersisted.set(count);
  }

  /** Сколько доплат ждут счёта в банке. Норма — ноль. */
  setPaymentInvoicesMissing(count: number): void {
    this.paymentInvoicesMissing.set(count);
  }

  /** Текст в формате экспозиции Prometheus. */
  async scrape(): Promise<{ body: string; contentType: string }> {
    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }
}

/**
 * Секунды между двумя отметками монотонных часов.
 *
 * `hrtime` — не прихоть: стенные часы прыгают от NTP, и прыжок назад посреди
 * замера дал бы отрицательную длительность в гистограмме (CLAUDE.md §4.3).
 */
export function secondsSince(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}
