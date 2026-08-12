import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { BidService } from '../auction/bid.service';
import { RedisService } from '../redis/redis.service';

/** Кому доставлять события лота. Ровно то, что нужно комнате от соединения. */
export interface RoomMember {
  readonly id: string;
  send(payload: string): void;
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

  async join(lotId: string, member: RoomMember): Promise<void> {
    let room = this.rooms.get(lotId);
    if (room === undefined) {
      room = new Set<RoomMember>();
      this.rooms.set(lotId, room);
      await this.subscriber.subscribe(this.bids.channel(lotId));
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
  private deliver(channel: string, payload: string): void {
    const lotId = channel.slice(channel.lastIndexOf(':') + 1);
    const room = this.rooms.get(lotId);
    if (room === undefined) {
      return;
    }

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
  }

  async onModuleDestroy(): Promise<void> {
    this.rooms.clear();
    await this.subscriber.quit().catch(() => this.subscriber.disconnect());
  }
}
