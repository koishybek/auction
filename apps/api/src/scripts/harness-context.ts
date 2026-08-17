// Обязан идти первым: без него декораторы Nest не находят метаданные типов и DI падает.
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { AuctionStateService } from '../auction/auction-state.service';
import {
  BidService,
  PLACE_BID_LUA,
  parseBidOutcome,
  type BidOutcome,
} from '../auction/bid.service';
import { RedisService } from '../redis/redis.service';

/**
 * Контейнер приложения для внешнего харнесса (`load/`).
 *
 * Зачем вообще: харнесс обязан ставить ставки ТЕМ ЖЕ кодом, что прод. Правило
 * шага +3 % существует в проекте в единственном экземпляре — в Lua-скрипте
 * (CLAUDE.md §4.2), и харнесс, собравший себе «такую же» арифметику, проверял
 * бы сам себя. Значит ему нужен настоящий DI-контейнер, а не выборочно
 * собранные руками сервисы.
 *
 * Почему функция живёт здесь, а не в `load/`: харнесс исполняется под tsx, а он
 * не умеет `emitDecoratorMetadata` — без неё DI в NestJS не собирается вовсе.
 * Поэтому `load/` импортирует уже СОБРАННЫЙ `dist`, а сборка контейнера — тут.
 * Побочная выгода: `load/` не тащит зависимости NestJS ради трёх строк.
 *
 * HTTP-слоя нет намеренно: харнессу нечего слушать, а открытый порт дрался бы
 * с запущенным рядом стендом.
 */
/** Один участник в пачке: свой id и свой псевдоним в лоте. */
export interface BurstBidder {
  readonly id: string;
  readonly blindCode: string;
}

export interface HarnessContext {
  readonly state: AuctionStateService;
  readonly bids: BidService;
  readonly redis: RedisService;
  /** Сто ставок одной записью в сокет. Смысл — в комментарии к реализации. */
  placeBurst(input: {
    lotId: string;
    expectedAmountTiyn: bigint;
    bidders: readonly BurstBidder[];
  }): Promise<readonly BidOutcome[]>;
  close(): Promise<void>;
}

export async function openHarnessContext(): Promise<HarnessContext> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    // Логи приложения в харнессе — шум: его собственный вывод и есть отчёт.
    logger: false,
    // Падение сборки контейнера должно быть исключением, а не тихим process.exit:
    // харнесс обязан отличить «не поднялось» от «проверка не прошла».
    abortOnError: false,
  });

  const bids = app.get(BidService);
  const redis = app.get(RedisService);

  /**
   * Скрипт грузится один раз и вызывается по SHA — иначе каждая ставка в пачке
   * тащила бы по сети тело скрипта, и «одна запись в сокет» превратилась бы в
   * сотню килобайт.
   */
  let sha: string | null = null;

  return {
    state: app.get(AuctionStateService),
    bids,
    redis,

    /**
     * Самая жёсткая форма гонки: все ставки уходят одной записью в сокет.
     *
     * Зачем так, а не сотней обычных вызовов: одна ставка оборачивается за ~2
     * мс, а сто последовательных записей в сокет из одного процесса занимают
     * десятки миллисекунд. То есть первая ставка успевает выполниться задолго до
     * того, как уйдёт последняя, и «сто одновременных ставок» распадается на
     * очередь. Здесь же все сто уходят одной отправкой, и ни одна не
     * формируется после того, как стал известен исход другой — это и есть
     * гонка в том смысле, в каком её требует DoD T-052.
     *
     * Чего это НЕ утверждает: что Redis дождался всех ста команд перед
     * выполнением первой. Он выполняет их подряд из своего буфера, и порядок
     * внутри пачки неизвестен — но он и не важен.
     *
     * Тело каждого вызова собирает сам `BidService`: копия соглашения о порядке
     * аргументов проверяла бы себя, а не боевой путь ставки.
     */
    async placeBurst(input): Promise<readonly BidOutcome[]> {
      sha ??= await loadScript(redis);

      const pipeline = redis.client.pipeline();
      for (const bidder of input.bidders) {
        const call = bids.placementCall({
          lotId: input.lotId,
          bidderId: bidder.id,
          blindCode: bidder.blindCode,
          expectedAmountTiyn: input.expectedAmountTiyn,
        });
        pipeline.evalsha(sha, call.keys.length, ...call.keys, ...call.args);
      }

      const replies = await pipeline.exec();
      if (replies === null) {
        throw new Error('Пачка ставок не выполнилась: Redis не ответил');
      }
      return replies.map(([error, raw]) => {
        if (error !== null) {
          throw error;
        }
        return parseBidOutcome(raw);
      });
    },

    close: () => app.close(),
  };
}

async function loadScript(redis: RedisService): Promise<string> {
  const sha: unknown = await redis.client.script('LOAD', PLACE_BID_LUA);
  if (typeof sha !== 'string') {
    throw new Error(`SCRIPT LOAD вернул не строку: ${String(sha)}`);
  }
  return sha;
}
