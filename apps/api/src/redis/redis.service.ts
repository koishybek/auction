import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { Env } from '../config/env.schema';

import { RedisScript } from './redis-script';

/**
 * Единственное соединение с Redis на приложение.
 *
 * Redis здесь не кэш, а авторитет по состоянию торгов (CLAUDE.md §4.3): цена,
 * дедлайн, seq. Поэтому клиент один и общий — множить соединения по модулям
 * значит получить разные представления о том, что сейчас происходит с лотом.
 *
 * Пространство имён (`auction:`) выносится в конфиг не для красоты: e2e гоняются
 * на том же Redis, что и разработка, и без разделения прогон тестов вычищал бы
 * рабочие ключи. Тот же механизм разводит стенды на одном managed-инстансе,
 * где несколько логических баз недоступны.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string;
  private readonly namespace: string;
  private readonly extra: Redis[] = [];

  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('REDIS_URL', { infer: true });
    this.namespace = config.get('REDIS_NAMESPACE', { infer: true });
    this.client = this.createClient('main');
  }

  /**
   * Ключ в пространстве имён приложения: key('lot', id, 'viewed') →
   * auction:lot:<id>:viewed. Без аргументов отдаёт само пространство имён —
   * этим e2e находит собственные ключи, чтобы убрать за собой.
   */
  key(...parts: readonly (string | number)[]): string {
    return [this.namespace, ...parts].join(':');
  }

  script(source: string): RedisScript {
    return new RedisScript(this.client, source);
  }

  /**
   * Дополнительное соединение под задачу, которой мало общего клиента.
   *
   * Соединение в режиме подписки не принимает обычных команд — WS-gateway
   * (T-023) обязан слушать pub/sub на своём. Такие клиенты регистрируются
   * здесь же, чтобы закрыться вместе с приложением, а не остаться висеть.
   */
  createDedicatedClient(label: string): Redis {
    const client = this.createClient(label);
    this.extra.push(client);
    return client;
  }

  /**
   * Соединение для BullMQ.
   *
   * `maxRetriesPerRequest: null` здесь обязателен: воркер ждёт задачу
   * блокирующей командой, и для обычного клиента это висящий запрос, который
   * он оборвёт по лимиту попыток. BullMQ прямо требует такую настройку.
   */
  createQueueConnection(label: string): Redis {
    const client = this.createClient(label, null);
    this.extra.push(client);
    return client;
  }

  /**
   * `maxRetriesPerRequest` отдельным параметром, а не объектом опций: спред
   * необязательных полей ioredis не проходит exactOptionalPropertyTypes, а
   * ослаблять правило ради одного ключа — плохой размен.
   */
  private createClient(label: string, maxRetriesPerRequest: number | null = 3): Redis {
    const client = new Redis(this.url, {
      // Видно в CLIENT LIST: при разборе инцидента сразу ясно, кто держит соединение.
      connectionName: `${this.namespace}:${label}`,
      // Команда не должна висеть вечно: подвисший INCR в обработчике ставки
      // держит HTTP-запрос до таймаута клиента, а участник видит «не отвечает».
      maxRetriesPerRequest,
    });

    // Без слушателя ioredis печатает «Unhandled error event» и роняет процесс:
    // кратковременная недоступность Redis не повод убивать API целиком.
    client.on('error', (error: Error) => {
      this.logger.error(`Redis (${label}): ${error.message}`);
    });

    return client;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [this.client, ...this.extra].map(async (client) => {
        // quit() ждёт ответа сервера; если соединения уже нет, ждать нечего.
        await client.quit().catch(() => client.disconnect());
      }),
    );
  }
}
