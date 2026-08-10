/**
 * Проверка dev-окружения: доступны ли managed PostgreSQL и Redis и умеют ли они
 * то, на чём построено ядро аукциона.
 *
 * Это замена «docker compose up» из исходной формулировки T-002: локальный Docker
 * в проекте не используется, инфраструктура — managed (Neon + Redis Cloud).
 *
 * Проверяем не «пинг ради пинга», а конкретные возможности, без которых Phase 3
 * не поедет:
 *   - Lua (EVAL)              — атомарное ядро ставки, T-024
 *   - PTTL в миллисекундах    — таймер 50 000 мс, FR-01
 *   - pub/sub                 — горизонтальное масштабирование WS-gateway, T-023
 *   - права на DDL в Postgres — миграции, T-007
 *
 * Запуск: pnpm check:env
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { config as loadEnv } from 'dotenv';
import Redis from 'ioredis';
import { Client } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number | null;
}

const MIN_POSTGRES_MAJOR = 16;
const MIN_REDIS_MAJOR = 7;
const CONNECT_TIMEOUT_MS = 15_000;

/** Ищем корень воркспейса вверх по дереву — чтобы скрипт работал из любой директории. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function ok(name: string, detail: string, ms: number | null): CheckResult {
  return { name, ok: true, detail, ms };
}

function fail(name: string, detail: string): CheckResult {
  return { name, ok: false, detail, ms: null };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} [${code}]` : error.message;
  }
  return String(error);
}

function majorVersion(raw: string): number {
  const match = /(\d+)/.exec(raw);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Локальный ли адрес.
 *
 * Решение dev-окружения: для localhost шифрование не требуется — трафик не покидает
 * машину, а локальный PostgreSQL работает по trust-аутентификации. Это осознанный
 * выбор, а не недоделка (docs/dev-setup.md). Для любого удалённого хоста отсутствие
 * TLS остаётся ошибкой: там в трафике ходят ПДн и деньги.
 */
function isLocal(url: string): boolean {
  try {
    // URL.hostname отдаёт IPv6 в скобках («[::1]»), их надо снять — иначе ::1
    // не распознаётся как локальный и проверка ругается на ровном месте.
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

/**
 * @param label   какую именно строку проверяем (пулер или прямое соединение)
 * @param ddl     проверять ли права на DDL: имеет смысл только для DIRECT_URL,
 *                через пулер миграции всё равно не ходят
 */
async function checkPostgres(label: string, url: string, ddl: boolean): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });

  const started = performance.now();
  try {
    await client.connect();
  } catch (error) {
    return [fail(`${label}: соединение`, describeError(error))];
  }
  const connectMs = Math.round(performance.now() - started);

  try {
    const version = await client.query<{ version: string }>('SELECT version()');
    const raw = version.rows[0]?.version ?? '';
    const major = majorVersion(raw.replace(/^PostgreSQL\s+/, ''));
    results.push(
      major >= MIN_POSTGRES_MAJOR
        ? ok(`${label}: соединение`, `PostgreSQL ${major}`, connectMs)
        : fail(`${label}: версия`, `PostgreSQL ${major}, нужен ≥${MIN_POSTGRES_MAJOR}`),
    );

    const tls = await client.query<{ ssl: boolean }>(
      "SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl",
    );
    const tlsOn = tls.rows[0]?.ssl === true;
    results.push(
      tlsOn
        ? ok(`${label}: TLS`, 'соединение шифруется', null)
        : isLocal(url)
          ? ok(`${label}: TLS`, 'localhost — шифрование не требуется (решение dev-окружения)', null)
          : fail(`${label}: TLS`, 'удалённый Postgres без шифрования — добавь sslmode=require'),
    );

    if (ddl) {
      // Миграциям нужны CREATE/DROP. Проверяем на временной таблице, ничего не оставляя.
      await client.query('CREATE TEMP TABLE _auction_env_probe (id int PRIMARY KEY)');
      await client.query('INSERT INTO _auction_env_probe (id) VALUES (1)');
      await client.query('DROP TABLE _auction_env_probe');
      results.push(ok(`${label}: права DDL`, 'CREATE/INSERT/DROP разрешены', null));
    }

    const latencyStart = performance.now();
    await client.query('SELECT 1');
    results.push(ok(`${label}: RTT запроса`, 'SELECT 1', Math.round(performance.now() - latencyStart)));
  } catch (error) {
    results.push(fail(`${label}: проверка`, describeError(error)));
  } finally {
    await client.end().catch(() => undefined);
  }

  return results;
}

// ─── Redis ───────────────────────────────────────────────────────────────────

interface RedisHandle {
  readonly client: Redis;
  /** Последняя ошибка из события 'error': ioredis прячет её за общим «Connection is closed». */
  lastError: Error | null;
}

function createRedis(url: string): RedisHandle {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    // Без этого ioredis будет переподключаться вечно и скрипт зависнет вместо внятной ошибки.
    retryStrategy: () => null,
  });
  const handle: RedisHandle = { client, lastError: null };
  // Слушатель обязателен: без него ioredis печатает сырой дамп «Unhandled error event»
  // поверх нашего отчёта. Ошибку сохраняем, чтобы показать причину, а не следствие.
  client.on('error', (error: Error) => {
    handle.lastError = error;
  });
  return handle;
}

async function checkRedis(url: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const handle = createRedis(url);
  const client = handle.client;

  const started = performance.now();
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    client.disconnect();
    return [fail('Redis: соединение', describeError(handle.lastError ?? error))];
  }
  const connectMs = Math.round(performance.now() - started);

  let subscriber: RedisHandle | null = null;
  try {
    const info = await client.info('server');
    const versionLine = /redis_version:(\S+)/.exec(info);
    const major = majorVersion(versionLine?.[1] ?? '0');
    results.push(
      major >= MIN_REDIS_MAJOR
        ? ok('Redis: соединение', `Redis ${versionLine?.[1] ?? '?'}`, connectMs)
        : fail('Redis: версия', `Redis ${major}, нужен ≥${MIN_REDIS_MAJOR}`),
    );

    results.push(
      url.startsWith('rediss://')
        ? ok('Redis: TLS', 'rediss:// — соединение шифруется', null)
        : isLocal(url)
          ? ok('Redis: TLS', 'localhost — шифрование не требуется (решение dev-окружения)', null)
          : fail('Redis: TLS', 'удалённый Redis без TLS — используй rediss://'),
    );

    // T-024: ядро ставки — единственный Lua-скрипт. Managed-тарифы иногда режут EVAL.
    const luaKey = '__auction:probe:lua';
    const lua = await client.eval(
      "redis.call('SET', KEYS[1], ARGV[1], 'PX', 200); return redis.call('GET', KEYS[1])",
      1,
      luaKey,
      'ok',
    );
    results.push(
      lua === 'ok'
        ? ok('Redis: Lua (EVAL)', 'атомарный скрипт ставки выполним', null)
        : fail('Redis: Lua (EVAL)', `неожиданный ответ: ${String(lua)}`),
    );

    // FR-01: таймер 50 000 мс. Нужна миллисекундная точность TTL, а не секундная.
    await client.set(luaKey, '1', 'PX', 50_000);
    const pttl = await client.pttl(luaKey);
    results.push(
      pttl > 49_000 && pttl <= 50_000 && pttl % 1000 !== 0
        ? ok('Redis: PTTL (мс)', `${pttl} мс — точность миллисекундная`, null)
        : pttl > 49_000 && pttl <= 50_000
          ? ok('Redis: PTTL (мс)', `${pttl} мс`, null)
          : fail('Redis: PTTL (мс)', `вернулось ${pttl}, ожидалось ~50000`),
    );
    await client.del(luaKey);

    // T-023: gateway stateless, события между инстансами ходят через pub/sub.
    subscriber = createRedis(url);
    const sub = subscriber.client;
    await sub.connect();
    const channel = '__auction:probe:pubsub';
    const roundTrip = await new Promise<number | null>((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise(null), 5_000);
      const publishedAt = performance.now();
      sub.on('message', () => {
        clearTimeout(timeout);
        resolvePromise(Math.round(performance.now() - publishedAt));
      });
      void sub
        .subscribe(channel)
        .then(() => client.publish(channel, 'ping'))
        .catch(() => {
          clearTimeout(timeout);
          resolvePromise(null);
        });
    });
    results.push(
      roundTrip === null
        ? fail('Redis: pub/sub', 'сообщение не дошло за 5 с — без этого gateway не масштабируется')
        : ok('Redis: pub/sub', 'сообщение доставлено', roundTrip),
    );
  } catch (error) {
    results.push(fail('Redis: проверка', describeError(handle.lastError ?? error)));
  } finally {
    if (subscriber) subscriber.client.disconnect();
    client.disconnect();
  }

  return results;
}

// ─── Вывод ───────────────────────────────────────────────────────────────────

function render(results: readonly CheckResult[]): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const mark = r.ok ? '  OK  ' : ' FAIL ';
    const timing = r.ms === null ? '' : `  (${r.ms} мс)`;
    console.log(`[${mark}] ${r.name.padEnd(width)}  ${r.detail}${timing}`);
  }
}

async function main(): Promise<void> {
  const root = findRepoRoot(process.cwd());
  const envPath = resolve(root, '.env');

  if (!existsSync(envPath)) {
    console.error(`\n.env не найден: ${envPath}\n`);
    console.error('Заполни окружение:');
    console.error('  1. cp .env.example .env');
    console.error('  2. вставь DATABASE_URL / DIRECT_URL (Neon) и REDIS_URL (Redis Cloud)');
    console.error('  3. пошагово — docs/dev-setup.md\n');
    process.exitCode = 1;
    return;
  }
  loadEnv({ path: envPath });

  const required = ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'] as const;
  const missing = required.filter((key) => {
    const value = process.env[key];
    // Незаполненный шаблон — это тоже «не задано», иначе получим невнятный DNS-фейл.
    return value === undefined || value.trim() === '' || value.includes('PASSWORD');
  });
  if (missing.length > 0) {
    console.error(`\nНе заполнены переменные в ${envPath}:`);
    for (const key of missing) console.error(`  - ${key}`);
    console.error('\nГде их взять — docs/dev-setup.md\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\nПроверка dev-окружения (${envPath})\n`);

  const results: CheckResult[] = [
    ...(await checkPostgres('Postgres (пулер)', process.env['DATABASE_URL'] as string, false)),
    ...(await checkPostgres('Postgres (прямое)', process.env['DIRECT_URL'] as string, true)),
    ...(await checkRedis(process.env['REDIS_URL'] as string)),
  ];

  render(results);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nПровалено проверок: ${failed.length}. Окружение не готово.\n`);
    process.exitCode = 1;
    return;
  }
  console.log('\nОкружение готово: PostgreSQL и Redis отвечают, Lua / PTTL / pub-sub работают.\n');
}

void main().catch((error: unknown) => {
  console.error('\nНеожиданная ошибка проверки:', describeError(error), '\n');
  process.exitCode = 1;
});
