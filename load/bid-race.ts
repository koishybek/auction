import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Типы берутся из СОБРАННОГО dist, а не из исходников: исходники api написаны
// на декораторах, и втянуть их в программу харнесса значит требовать от неё
// настроек компилятора NestJS. Объявления в dist от декораторов свободны.
import type { BidOutcome } from '../apps/api/dist/auction/bid.service.js';
import type { HarnessContext } from '../apps/api/dist/scripts/harness-context.js';
import { repoRoot, stackEnv } from '../e2e/stack';

/**
 * Concurrency-харнесс ставок (T-052, QA-02).
 *
 * Проверяет главный риск проекта: сто участников одновременно ставят на один и
 * тот же шаг одного лота. Принять обязан ровно одного. Две принятые ставки на
 * один шаг — это не «расхождение счётчика», а юридический спор о деньгах;
 * потерянная ставка — тоже.
 *
 * Одного прогона мало: гонка редка по своей природе, и совпадение таймингов,
 * которое её ломает, ловится не с первого раза. Поэтому DoD требует сотню
 * прогонов, и харнесс валится на первом же отклонении, а не усредняет его.
 *
 * Сценариев два, и это не дублирование:
 *   - «пачкой» — все сто ставок уходят ОДНОЙ записью в сокет. Ни одна не может
 *     быть обработана раньше, чем в буфер Redis попадут все сто: окно
 *     совпадения меньше миллисекунды, как требует DoD.
 *   - «по одной» — сто обычных вызовов из одного tick. Так ставит настоящий
 *     код, и так измеряется, во что на самом деле обходится отправка сотни
 *     ставок с одной машины.
 *
 * Почему не по WebSocket, как выглядит настоящий `place_bid`: лимит частоты
 * считает не только по сессии, но и по АДРЕСУ (FR-10, 1 ставка / 500 мс). Сто
 * ставок с одной машины — это один адрес, и девяносто девять из них система
 * отклонила бы как автокликер, до всякой гонки. Это правильное поведение
 * системы и негодный способ проверить ядро: харнесс бьёт в путь ставки, а
 * транспорт и лимит проверены своими e2e (gateway, bid-rate-limit).
 */

const RUNS = Number(process.env['RUNS'] ?? '100');
const BIDDERS = Number(process.env['BIDDERS'] ?? '100');
const START_PRICE_TENGE = 45_000_000;

/** Сколько одиночных ставок делает прогрев — на них считается базовый оборот. */
const WARMUP_BIDS = 20;

/**
 * Своё пространство имён.
 *
 * Не косметика: харнесс за прогон оставляет в Redis сотни состояний торгов и
 * записи в outbox по лотам, которых нет в PostgreSQL. Попади они в рабочее
 * пространство — перенос ставок в базу встал бы навсегда на внешнем ключе, и
 * выглядело бы это как «лента пустая» (CLAUDE.md §4.3).
 */
const NAMESPACE = 'auction-race';

/** Как отправляются ставки одного прогона. */
type Mode = 'burst' | 'single';

interface RunStats {
  /** Разброс моментов отправки: сколько прошло между первой ставкой и последней. */
  readonly dispatchWindowMs: number;
  /** Прогон целиком — от первой отправки до последнего ответа. */
  readonly elapsedMs: number;
}

interface Report {
  readonly mode: Mode;
  readonly stats: readonly RunStats[];
}

function fail(message: string): never {
  throw new Error(message);
}

/** Медиана. Сортируем копию: порядок прогонов ещё нужен для отчёта. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * share));
  return sorted[index] ?? 0;
}

function ms(value: number): string {
  return `${value.toFixed(3)} мс`;
}

function elapsedSince(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

async function main(): Promise<void> {
  const dist = resolve(repoRoot(), 'apps', 'api', 'dist', 'scripts', 'harness-context.js');
  if (!existsSync(dist)) {
    fail('Нет apps/api/dist — соберите API: pnpm --filter @auction/api build');
  }

  /**
   * Окружение выставляется ДО импорта контейнера: @nestjs/config читает и
   * валидирует переменные в момент сборки модуля, а не при первом обращении.
   */
  Object.assign(process.env, { ...stackEnv(), REDIS_NAMESPACE: NAMESPACE });
  if (process.env['REDIS_NAMESPACE'] === 'auction') {
    fail('Пространство имён совпало с рабочим — харнесс вычистил бы рабочие ключи');
  }

  const { openHarnessContext } = (await import(
    // На Windows абсолютный путь начинается с буквы диска, а загрузчик модулей
    // принимает только file:// — без преобразования импорт падает на «протоколе c:».
    pathToFileURL(dist).href
  )) as typeof import('../apps/api/dist/scripts/harness-context.js');

  const ctx: HarnessContext = await openHarnessContext();

  /** Убрать за собой: и до прогона, и после. FLUSHDB запрещён (CLAUDE.md §2). */
  async function clearNamespace(): Promise<number> {
    const pattern = `${ctx.redis.key()}:*`;
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await ctx.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      if (keys.length > 0) {
        removed += await ctx.redis.client.del(...keys);
      }
      cursor = next;
    } while (cursor !== '0');
    return removed;
  }

  /** Свежие торги: цена уже сдвинулась, и второй гонки на том же шаге не будет. */
  async function openSession(): Promise<string> {
    const lotId = randomUUID();
    await ctx.state.start({
      lotId,
      sessionId: randomUUID(),
      priceTiyn: BigInt(START_PRICE_TENGE) * 100n,
    });
    return lotId;
  }

  /**
   * Проверить исход гонки. Валится на первом же отклонении: усреднять здесь
   * нечего — одна лишняя принятая ставка означает спор о деньгах.
   */
  function verify(
    label: string,
    outcomes: readonly BidOutcome[],
    contested: bigint,
    afterContested: bigint,
  ): void {
    if (outcomes.length !== BIDDERS) {
      fail(`${label}: ответов ${String(outcomes.length)} вместо ${String(BIDDERS)}`);
    }

    // DoD: ровно одна принятая ставка.
    const accepted = outcomes.filter((outcome) => outcome.status === 'ACCEPTED');
    if (accepted.length !== 1) {
      fail(`${label}: принято ${String(accepted.length)} ставок вместо одной`);
    }
    const winner = accepted[0];
    if (winner?.status !== 'ACCEPTED' || winner.priceTiyn !== contested || winner.seq !== 1) {
      fail(`${label}: принятая ставка не на спорный шаг`);
    }

    // DoD: остальные — корректные отказы, и каждый называет актуальную цену.
    for (const outcome of outcomes) {
      if (outcome.status !== 'REJECTED') {
        continue;
      }
      if (outcome.code !== 'PRICE_MISMATCH') {
        fail(`${label}: отказ с кодом ${outcome.code} вместо PRICE_MISMATCH`);
      }
      // Без цены в отказе проигравший узнавал бы её отдельным запросом — то
      // есть в гонке за лот сервер получал бы столько запросов, сколько
      // проигравших, ровно в самый нагруженный момент.
      if (outcome.live === undefined) {
        fail(`${label}: отказ не назвал актуальную цену`);
      }
      if (outcome.live.priceTiyn !== contested) {
        fail(
          `${label}: в отказе цена ${String(outcome.live.priceTiyn)} ` +
            `вместо ${String(contested)}`,
        );
      }
      if (outcome.live.nextPriceTiyn !== afterContested) {
        fail(
          `${label}: в отказе следующая сумма ${String(outcome.live.nextPriceTiyn)} ` +
            `вместо ${String(afterContested)}`,
        );
      }
      if (outcome.live.seq !== 1) {
        fail(`${label}: в отказе seq ${String(outcome.live.seq)} вместо 1`);
      }
    }
  }

  async function race(mode: Mode, run: number): Promise<RunStats> {
    const label = `${mode}, прогон ${String(run)}`;
    const lotId = await openSession();
    const contested = await ctx.bids.nextPriceTiyn(lotId);

    const bidders = Array.from({ length: BIDDERS }, (_, index) => ({
      id: `race-${mode}-${String(run)}-${String(index)}`,
      blindCode: `Инвестор #${String(index).padStart(3, '0')}`,
    }));

    const startedAt = process.hrtime.bigint();
    let outcomes: readonly BidOutcome[];
    let dispatchWindowMs: number;

    if (mode === 'burst') {
      // Отправка одна на всю пачку — разброса моментов отправки нет по
      // построению, а не по замеру.
      outcomes = await ctx.placeBurst({ lotId, expectedAmountTiyn: contested, bidders });
      dispatchWindowMs = 0;
    } else {
      /**
       * `Array.from` вызывает функцию для каждого индекса подряд, не отдавая
       * управление, поэтому все сто ставок начинаются в один tick. Но каждая
       * пишет в сокет сама — и вот эта запись оказывается дорогой.
       */
      const dispatched: bigint[] = [];
      const pending: Promise<BidOutcome>[] = Array.from({ length: BIDDERS }, (_, index) => {
        dispatched.push(process.hrtime.bigint());
        const bidder = bidders[index];
        return ctx.bids.place({
          lotId,
          bidderId: bidder?.id ?? '',
          blindCode: bidder?.blindCode ?? '',
          expectedAmountTiyn: contested,
        });
      });
      const first = dispatched[0] ?? 0n;
      const last = dispatched[dispatched.length - 1] ?? 0n;
      dispatchWindowMs = Number(last - first) / 1e6;
      outcomes = await Promise.all(pending);
    }

    const elapsedMs = elapsedSince(startedAt);

    // Сумма следующего шага — из ответа сервера первой же ставки: считать её
    // здесь значило бы завести вторую реализацию правила +3 % (CLAUDE.md §4.2).
    const afterContested = firstNextPrice(outcomes, label);
    verify(label, outcomes, contested, afterContested);

    // Состояние сдвинулось ровно на один шаг и ровно на один номер.
    const live = await ctx.state.read(lotId);
    if (live?.priceTiyn !== contested || live.seq !== 1) {
      fail(
        `${label}: состояние ${String(live?.priceTiyn)}/${String(live?.seq)} ` +
          `вместо ${String(contested)}/1`,
      );
    }

    return { dispatchWindowMs, elapsedMs };
  }

  async function series(mode: Mode): Promise<Report> {
    const stats: RunStats[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      stats.push(await race(mode, run));
      if ((run + 1) % 25 === 0) {
        console.log(`[race] ${mode}: прогонов пройдено ${String(run + 1)}/${String(RUNS)}`);
      }
    }
    return { mode, stats };
  }

  try {
    const cleaned = await clearNamespace();
    console.log(
      `[race] пространство ${NAMESPACE}: убрано ключей ${String(cleaned)}; ` +
        `прогонов ${String(RUNS)} × ставок ${String(BIDDERS)} × 2 сценария`,
    );

    /**
     * Прогрев и базовый оборот одиночной ставки.
     *
     * Без него непонятно, была ли гонка гонкой: если сто ставок заняли столько
     * же, сколько сто одиночных, значит они шли по очереди. Он же снимает
     * компиляцию скрипта — первый вызов грузит тело, дальше идёт SHA.
     */
    const warmupLot = await openSession();
    const soloSamples: number[] = [];
    for (let index = 0; index < WARMUP_BIDS; index += 1) {
      const at = process.hrtime.bigint();
      // Ставят по очереди двое: перебивать собственную ставку нельзя (T-025).
      await ctx.bids.place({
        lotId: warmupLot,
        bidderId: `warmup-${String(index % 2)}`,
        blindCode: 'Инвестор #001',
        expectedAmountTiyn: await ctx.bids.nextPriceTiyn(warmupLot),
      });
      soloSamples.push(elapsedSince(at));
    }
    const solo = median(soloSamples);

    const reports = [await series('burst'), await series('single')];

    /**
     * Сквозная проверка: в outbox ровно столько ставок, сколько принято.
     *
     * Пишет в поток тот же атомарный скрипт, который принимает ставку, поэтому
     * лишняя запись означала бы вторую принятую ставку, а недостающая —
     * потерянную. Ставки прогрева тоже в счёт.
     */
    const persisted = await ctx.redis.client.xlen(ctx.bids.outboxKey());
    const expected = RUNS * reports.length + WARMUP_BIDS;
    if (persisted !== expected) {
      fail(`В outbox ${String(persisted)} ставок вместо ${String(expected)}`);
    }

    console.log('');
    console.log(`Прогонов на сценарий:          ${String(RUNS)} × ${String(BIDDERS)} ставок`);
    console.log(`Принято на прогон:             1 — на каждом прогоне обоих сценариев`);
    console.log(
      `Отказов PRICE_MISMATCH:        ${String(BIDDERS - 1)} на прогон ` +
        `(всего ${String(RUNS * reports.length * (BIDDERS - 1))}), каждый с актуальной ценой`,
    );
    console.log(`Ставок в outbox:               ${String(persisted)} = принятые + прогрев`);
    console.log(`Одиночная ставка (медиана):    ${ms(solo)}`);
    console.log('');

    for (const report of reports) {
      const elapsed = report.stats.map((item) => item.elapsedMs);
      const windows = report.stats.map((item) => item.dispatchWindowMs);
      const worstWindow = Math.max(...windows);
      const title = report.mode === 'burst' ? 'Пачкой (одна запись)' : 'По одной (боевой путь)';

      console.log(`${title}:`);
      console.log(`  окно отправки, худшее        ${ms(worstWindow)}`);
      console.log(
        `  прогон целиком               медиана ${ms(median(elapsed))}, ` +
          `p95 ${ms(percentile(elapsed, 0.95))}, худший ${ms(Math.max(...elapsed))}`,
      );
      console.log(
        `  быстрее очереди из ста       ×${((solo * BIDDERS) / median(elapsed)).toFixed(1)}`,
      );

      // Требование DoD «сто ставок в 1 мс» проверяется на том сценарии, где
      // одновременность достижима. На боевом пути окно измеряется и
      // докладывается: подгонять порог под результат нельзя, а объяснить его —
      // нужно (см. load/README.md).
      if (report.mode === 'burst' && worstWindow > 1) {
        fail(`Окно отправки пачкой ${ms(worstWindow)} — DoD требует уложиться в 1 мс`);
      }
    }

    console.log('');
    console.log('[race] DoD T-052 выполнен: ровно одна принятая ставка на каждом прогоне');
  } finally {
    // Убираем и на успехе, и на падении: оставленные ключи встали бы поперёк
    // следующего прогона, а записи в outbox — поперёк переноса ставок в базу.
    await clearNamespace();
    await ctx.close();
  }
}

/**
 * Сумма следующей ставки по версии сервера.
 *
 * Берётся из первого же отказа, а не считается здесь: правило шага живёт в
 * одном месте, и харнесс, посчитавший его сам, сверял бы сервер со своей
 * арифметикой вместо правил торгов.
 */
function firstNextPrice(outcomes: readonly BidOutcome[], label: string): bigint {
  for (const outcome of outcomes) {
    if (outcome.status === 'REJECTED' && outcome.live !== undefined) {
      return outcome.live.nextPriceTiyn;
    }
  }
  return fail(`${label}: ни один отказ не назвал сумму следующей ставки`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
