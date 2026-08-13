import {
  SMART_HAMMER_TIMER_MS,
  toTenge,
  tiyn,
  type AuctionStateView,
  type BidUpdatedEvent,
} from '@auction/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { LotsService } from '../lots/lots.service';
import { PrismaService } from '../prisma/prisma.service';

import { AuctionStateService, type AuctionState } from './auction-state.service';

/**
 * Торговая сессия (T-022).
 *
 * Отвечает за одну вещь: чтобы состояние торгов в PostgreSQL и в Redis
 * описывало одни и те же торги. PostgreSQL хранит факт сессии и её дедлайн —
 * это доказательство на случай спора; Redis ведёт живое состояние, которое
 * меняется каждой ставкой.
 */
@Injectable()
export class AuctionService {
  private readonly logger = new Logger(AuctionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: AuctionStateService,
    private readonly lots: LotsService,
  ) {}

  /**
   * Открыть торги по лоту: PHASE_II → PHASE_III плюс состояние в Redis.
   *
   * Порядок важен. Сначала статус лота — переход проверяет статусная машина, и
   * если он невозможен, никаких следов не остаётся. Потом строка сессии в
   * PostgreSQL. Последним — состояние в Redis, потому что именно оно
   * восстановимо: сессия без ключа чинится вызовом ensureState, а вот ключ без
   * строки в PostgreSQL означал бы торги, которых юридически не было.
   *
   * Дедлайн считает Redis и возвращает нам — в PostgreSQL уезжает ровно то
   * значение, с которым потом сверяется скрипт ставки.
   */
  async start(lotId: string, actorId: string): Promise<AuctionStateView> {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (lot === null) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }

    const running = await this.prisma.auctionSession.findFirst({
      where: { lotId, status: { in: ['RUNNING', 'FROZEN'] } },
    });
    if (running !== null) {
      throw new ConflictException({
        code: 'SESSION_ALREADY_RUNNING',
        message: 'По этому лоту уже идут торги',
      });
    }

    // Стартовая цена торгов — стартовая цена лота: первая ставка поднимет её
    // на 3 %. Ставок ещё нет, поэтому currentPrice здесь взяться неоткуда.
    const priceTiyn = lot.startPriceTiyn;

    await this.lots.transition({ lotId, to: 'PHASE_III', actor: 'ADMIN', actorId });

    const session = await this.prisma.auctionSession.create({
      data: {
        lotId,
        status: 'RUNNING',
        // Значение временное: авторитетный дедлайн придёт из Redis ниже.
        deadlineAt: new Date(0),
      },
    });

    const { startedAtMs, deadlineMs } = await this.state.start({
      lotId,
      sessionId: session.id,
      priceTiyn,
    });

    const persisted = await this.prisma.auctionSession.update({
      where: { id: session.id },
      data: { deadlineAt: new Date(deadlineMs), startedAt: new Date(startedAtMs) },
    });

    // Цена торгов ведётся в Redis, но её начальное значение видно и в лоте:
    // каталог показывает «текущую цену», не заглядывая в состояние сессии.
    await this.prisma.lot.update({ where: { id: lotId }, data: { currentPriceTiyn: priceTiyn } });

    this.logger.log(`Лот ${lotId}: торги открыты, сессия ${persisted.id}`);

    // Читаем состояние обратно, а не собираем ответ из локальных переменных:
    // сумма следующего шага считается в Redis, и подменять её здесь значило бы
    // завести вторую реализацию правила округления.
    return this.snapshot(lotId);
  }

  /**
   * Снимок состояния торгов. Публичный: его же отдаёт gateway при входе
   * в комнату лота (T-023).
   */
  async snapshot(lotId: string): Promise<AuctionStateView> {
    const state = (await this.state.read(lotId)) ?? (await this.ensureState(lotId));
    if (state === null) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: 'По этому лоту торги не идут',
      });
    }
    return toStateView(lotId, state);
  }

  /**
   * Лента ставок: последние N, свежие сверху.
   *
   * Формат ровно тот же, что у события `bid_updated` (ТЗ §2.1) — клиенту не
   * приходится разбирать два разных представления одной и той же ставки: то,
   * что прилетело в реальном времени, и то, что он забрал после
   * переподключения.
   *
   * `time_remaining_ms` в истории — таймер на момент той ставки, то есть
   * всегда полные 50 секунд: каждая принятая ставка его сбрасывала.
   */
  async history(lotId: string, limit: number): Promise<BidUpdatedEvent[]> {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (lot === null) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }

    const bids = await this.prisma.bid.findMany({
      where: { lotId },
      orderBy: { seq: 'desc' },
      take: limit,
    });

    // Шаг — разница с предыдущей ставкой. Для самой первой предыдущей нет,
    // и точкой отсчёта служит стартовая цена лота.
    return bids.map((bid, index) => {
      const previousTiyn = bids[index + 1]?.amountTiyn ?? lot.startPriceTiyn;
      return {
        event: 'bid_updated' as const,
        lot_id: bid.lotId,
        session_id: bid.sessionId,
        current_price_kzt: Number(toTenge(tiyn(bid.amountTiyn))),
        bid_step_kzt: Number(toTenge(tiyn(bid.amountTiyn - previousTiyn))),
        last_bidder_blind_id: bid.blindCode,
        time_remaining_ms: SMART_HAMMER_TIMER_MS,
        timestamp: bid.serverTs.getTime(),
        seq: bid.seq,
      };
    });
  }

  /**
   * Восстановить состояние в Redis по данным PostgreSQL.
   *
   * Redis — авторитет, но не хранилище: перезапуск инстанса не должен означать
   * потерянные торги. Цена берётся из последней ставки, а не из лота: лот
   * обновляется пачками, а ставка — юридический факт, записанный append-only.
   */
  async ensureState(lotId: string): Promise<AuctionState | null> {
    const session = await this.prisma.auctionSession.findFirst({
      where: { lotId, status: { in: ['RUNNING', 'FROZEN'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (session === null) {
      return null;
    }

    const lastBid = await this.prisma.bid.findFirst({
      where: { sessionId: session.id },
      orderBy: { seq: 'desc' },
    });
    const lot = await this.prisma.lot.findUniqueOrThrow({ where: { id: lotId } });

    const restored = await this.state.restore({
      lotId,
      sessionId: session.id,
      status: session.status,
      priceTiyn: lastBid?.amountTiyn ?? lot.startPriceTiyn,
      seq: lastBid?.seq ?? 0,
      deadlineMs: session.deadlineAt.getTime(),
    });
    if (restored) {
      this.logger.warn(`Лот ${lotId}: состояние торгов восстановлено из PostgreSQL`);
    }

    return this.state.read(lotId);
  }
}

/**
 * Состояние сервера → снимок для клиента.
 *
 * Наружу уходит остаток в миллисекундах, а не дедлайн: клиентские часы в
 * механике не участвуют (CLAUDE.md §4.3). Остаток не бывает отрицательным —
 * «минус три секунды» на экране означали бы, что торги идут после закрытия.
 */
function toStateView(lotId: string, state: AuctionState): AuctionStateView {
  return {
    lotId,
    sessionId: state.sessionId,
    status: state.status,
    currentPriceTenge: Number(toTenge(tiyn(state.priceTiyn))),
    nextBidTenge: Number(toTenge(tiyn(state.nextPriceTiyn))),
    seq: state.seq,
    timeRemainingMs: Math.max(0, state.deadlineMs - state.nowMs),
    serverTs: state.nowMs,
  };
}
