import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { BidService } from '../auction/bid.service';
import { MetricsService, secondsSince } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';

/** Кому доставлять события лота. Ровно то, что нужно комнате от соединения. */
export interface RoomMember {
  readonly id: string;
  send(payload: string): void;
  /**
   * Жив ли ещё сокет.
   *
   * Нужен из-за одного окна: вход в НОВУЮ комнату ждёт подписки на канал Redis,
   * и за это время соединение может закрыться. Уборка при обрыве в этот момент
   * участника в комнате ещё не находит, а после подписки он в неё добавляется —
   * и остаётся там навсегда: комната никогда не опустеет, канал не отпишется, а
   * тик таймера будет рассылаться лоту, которого никто не смотрит. Реализация
   * необязательна: тестовому участнику проверять нечего.
   */
  isAlive?(): boolean;
}

/**
 * Комнаты лотов и мост через Redis pub/sub (T-023).
 *
 * Gateway stateless: он не знает, кто ещё поднят, и не хранит ничего, что
 * нельзя потерять. Всё, что нужно для масштабирования за балансировщиком, —
 * подписка на канал лота: ставка, принятая на любом инстансе, публикуется в
 * Redis и приходит всем сразу.
 *
 * Подписка живёт по требованию: канал открывается на первом вошедшем в комнату
 * и закрывается на последнем ушедшем. На инстансе, где лот никому не интересен,
 * его события не читаются вовсе — иначе каждый gateway тянул бы трафик всех
 * пятидесяти тысяч торгов, а не своих.
 */
@Injectable()
export class LotRoomsService implements OnModuleDestroy {
  private readonly logger = new Logger(LotRoomsService.name);
  private readonly rooms = new Map<string, Set<RoomMember>>();
  private readonly subscriber: Redis;

  constructor(
    redis: RedisService,
    private readonly bids: BidService,
    private readonly metrics: MetricsService,
  ) {
    // Отдельное соединение: в режиме подписки Redis не принимает обычных команд.
    this.subscriber = redis.createDedicatedClient('gateway:subscriber');
    this.subscriber.on('message', (channel: string, payload: string) => {
      this.deliver(channel, payload);
    });
  }

  /** Сколько соединений в комнате. Для метрик и проверок. */
  size(lotId: string): number {
    return this.rooms.get(lotId)?.size ?? 0;
  }

  /** Сколько комнат обслуживает этот инстанс. */
  roomCount(): number {
    return this.rooms.size;
  }

  /** Лоты, за которыми следит этот инстанс. Тикеру — список, кому вещать. */
  activeLots(): string[] {
    return [...this.rooms.keys()];
  }

  /** Соединений в самой большой комнате. По ней виден запас до 50 000 (NFR-03). */
  largestRoom(): number {
    let largest = 0;
    for (const room of this.rooms.values()) {
      largest = Math.max(largest, room.size);
    }
    return largest;
  }

  /** Разослать готовый кадр всем в комнате. */
  broadcast(lotId: string, payload: string): void {
    this.sendToRoom(lotId, payload, 'timer_tick');
  }

  async join(lotId: string, member: RoomMember): Promise<void> {
    let room = this.rooms.get(lotId);
    if (room === undefined) {
      room = new Set<RoomMember>();
      this.rooms.set(lotId, room);
      await this.subscriber.subscribe(this.bids.channel(lotId));

      // Пока шла подписка, соединение могло закрыться. Добавить его сейчас
      // значит оставить мёртвого участника в комнате навсегда: уборка при
      // обрыве его уже не искала, а комната без живых участников не опустеет и
      // не отпишется от канала.
      if (member.isAlive?.() === false) {
        if (room.size === 0) {
          this.rooms.delete(lotId);
          await this.subscriber.unsubscribe(this.bids.channel(lotId));
        }
        return;
      }
    }
    room.add(member);
  }

  async leave(lotId: string, member: RoomMember): Promise<void> {
    const room = this.rooms.get(lotId);
    if (room === undefined) {
      return;
    }
    room.delete(member);
    if (room.size === 0) {
      this.rooms.delete(lotId);
      await this.subscriber.unsubscribe(this.bids.channel(lotId));
    }
  }

  /** Убрать соединение из всех комнат — при обрыве связи. */
  async leaveAll(member: RoomMember): Promise<void> {
    const lotIds = [...this.rooms.entries()]
      .filter(([, room]) => room.has(member))
      .map(([lotId]) => lotId);
    for (const lotId of lotIds) {
      await this.leave(lotId, member);
    }
  }

  /**
   * Разослать пришедшее из Redis всем в комнате.
   *
   * Payload пересылается как есть, без разбора и обратной сборки: его собрал
   * Lua-скрипт ставки уже в том виде, в котором его ждёт клиент (ТЗ §2.1).
   * Разбирать и сериализовать заново на каждое соединение — это чистая потеря
   * на горячем пути, где SLA на рассылку 5 мс.
   */
  /**
   * Метка события для метрики вещания: `lot_event` для всего, что пришло из
   * pub/sub, `timer_tick` для тика.
   *
   * Точнее не различаем намеренно: имя события лежит внутри payload, а разбирать
   * JSON на горячем пути ради метки — это ровно та работа, от которой мы здесь
   * уходим. Различие «тик или событие лота» и есть то, что важно для SLA:
   * события лота — латентно-критичные, тик приходит по расписанию.
   */
  private deliver(channel: string, payload: string): void {
    this.sendToRoom(channel.slice(channel.lastIndexOf(':') + 1), payload, 'lot_event');
  }

  private sendToRoom(lotId: string, payload: string, event: string): void {
    const room = this.rooms.get(lotId);
    if (room === undefined) {
      return;
    }

    /**
     * Замер вещания. ОВ-2 определяет его дословно как «время постановки в
     * отправку» — то есть ровно длительность этого цикла, а не путь пакета до
     * браузера. Считать по часам («когда событие родилось в Redis» минус
     * «сейчас») нельзя: это разные часы, и метрика мерила бы дрейф NTP вместе с
     * работой gateway.
     */
    const startedAt = process.hrtime.bigint();

    for (const member of room) {
      try {
        member.send(payload);
      } catch (error) {
        // Одно мёртвое соединение не должно лишить событие остальных.
        this.logger.warn(
          `Не удалось доставить событие в ${member.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.metrics.observeBroadcast(event, secondsSince(startedAt));
  }

  async onModuleDestroy(): Promise<void> {
    this.rooms.clear();
    await this.subscriber.quit().catch(() => this.subscriber.disconnect());
  }
}
