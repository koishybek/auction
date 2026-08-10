import type { DependencyReport, DependencyStatus, ReadinessReport } from '@auction/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Client } from 'pg';

import type { Env } from '../config/env.schema';

// Типы ответа живут в @auction/shared: api их реализует, web потребляет.

/**
 * Проба не должна висеть: kubelet ждёт ответа считаные секунды, а зависшая
 * readiness-проба выглядит как «под жив», хотя он ни на что не отвечает.
 */
const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async checkReadiness(): Promise<ReadinessReport> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);

    const dependencies = { postgres, redis };
    const status: DependencyStatus = Object.values(dependencies).every((d) => d.status === 'up')
      ? 'up'
      : 'down';

    return { status, dependencies };
  }

  private async checkPostgres(): Promise<DependencyReport> {
    const started = Date.now();
    const client = new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
      query_timeout: PROBE_TIMEOUT_MS,
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (error) {
      return { status: 'down', latencyMs: null, error: describe(error) };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async checkRedis(): Promise<DependencyReport> {
    const started = Date.now();
    const client = new Redis(this.config.get('REDIS_URL', { infer: true }), {
      lazyConnect: true,
      connectTimeout: PROBE_TIMEOUT_MS,
      commandTimeout: PROBE_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      // Иначе ioredis уходит в бесконечный реконнект и проба не отвечает никогда.
      retryStrategy: () => null,
    });

    // Слушатель обязателен: без него ioredis печатает «Unhandled error event»
    // и роняет процесс, вместо того чтобы вернуть честный status: down.
    let lastError: Error | null = null;
    client.on('error', (error: Error) => {
      lastError = error;
    });

    try {
      await client.connect();
      await client.ping();
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (error) {
      return { status: 'down', latencyMs: null, error: describe(lastError ?? error) };
    } finally {
      client.disconnect();
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} [${code}]` : error.message;
  }
  return String(error);
}
