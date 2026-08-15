import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import { DepositPaymentsService } from './deposit-payments.service';
import { DepositsService } from './deposits.service';

/**
 * За один заход отправляем не больше этого числа поручений.
 *
 * Пачка ограничена не ради базы, а ради банка: тысяча поручений в одну секунду
 * после закрытия крупного лота — это отказ на их стороне, а не наша скорость.
 * Остаток уйдёт следующим заходом, SLA — сутки.
 */
const BATCH_SIZE = 50;

/** Метка «поручение отправляется прямо сейчас». Заявка занята этим воркером. */
const SENDING_PREFIX = 'sending:';

/**
 * Сколько ждём после закрытия торгов, прежде чем считать лот забытым.
 *
 * Возвраты открывает finisher в момент закрытия. Сверка — страховка на случай,
 * когда он до этого шага не дошёл, и вмешиваться раньше ей незачем: минуты
 * хватает и на запись ставок из outbox, и на повторную попытку.
 */
const RECONCILE_DELAY_MS = 60_000;

/**
 * Авто-возврат задатков (T-037, INT-04, FR-12).
 *
 * Проигравшим деньги возвращаются в течение 24 часов. Открывает возвраты
 * finisher в момент закрытия торгов, здесь — отправка поручений в банк.
 *
 * Главное свойство — ровно одно поручение на задаток при любом числе воркеров
 * и любом числе перезапусков. Держится оно не на осторожности кода, а на
 * атомарном захвате заявки в базе: `refund_ref` заполняется условием «был
 * пустым», и второй воркер получает ноль изменённых строк. Дважды вернуть
 * задаток хуже, чем вернуть с опозданием: со второго возврата деньги придётся
 * истребовать обратно.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: DepositPaymentsService,
    private readonly deposits: DepositsService,
    private readonly time: TimeService,
  ) {}

  /** Отправить поручения по задаткам, ждущим возврата. Возвращает число отправленных. */
  async triggerDue(): Promise<number> {
    const due = await this.prisma.deposit.findMany({
      where: { status: 'REFUND_PENDING', refundRef: null },
      select: { id: true },
      orderBy: { refundDeadlineAt: 'asc' },
      take: BATCH_SIZE,
    });

    let sent = 0;
    for (const deposit of due) {
      if (await this.trigger(deposit.id)) {
        sent += 1;
      }
    }
    if (sent > 0) {
      this.logger.log(`Отправлено поручений на возврат: ${String(sent)}`);
    }
    return sent;
  }

  /** Одно поручение. `false` — заявку уже занял кто-то другой либо банк отказал. */
  private async trigger(depositId: string): Promise<boolean> {
    const mark = `${SENDING_PREFIX}${randomUUID()}`;

    // Захват заявки. Условие `refundRef: null` — это и есть блокировка:
    // выиграет ровно один воркер, остальные увидят count = 0.
    const claimed = await this.prisma.deposit.updateMany({
      where: { id: depositId, status: 'REFUND_PENDING', refundRef: null },
      data: { refundRef: mark },
    });
    if (claimed.count === 0) {
      return false;
    }

    try {
      const refundId = await this.payments.requestRefund(depositId);
      await this.prisma.deposit.updateMany({
        where: { id: depositId, refundRef: mark },
        data: { refundRef: refundId },
      });
      return true;
    } catch (error) {
      // Банк не принял поручение — освобождаем заявку, следующий заход
      // попробует снова. Оставить её занятой значило бы потерять возврат
      // молча, и обнаружился бы он жалобой участника.
      await this.prisma.deposit.updateMany({
        where: { id: depositId, refundRef: mark },
        data: { refundRef: null },
      });
      this.logger.error(
        `Задаток ${depositId}: поручение не ушло — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Сверка: закрытые торги, где задатки так и остались на спецсчёте (T-037).
   *
   * Нужна, потому что открытие возвратов в finisher'е — обычный шаг обычного
   * кода: база могла быть недоступна ровно в ту секунду. Без сверки такой лот
   * молчал бы, пока не пожалуется участник.
   *
   * Победитель здесь берётся из ставок в PostgreSQL — ставка с наибольшим
   * номером в сессии. Если ставки были, а в базе их ещё нет, лот
   * пропускается: вернуть задаток победителю хуже, чем вернуть на минуту
   * позже. Факт «ставки были» проверяется по цене лота, а не по наличию
   * строк, — иначе проверка опиралась бы на то же, что и проверяет.
   */
  async reconcileFinishedLots(): Promise<number> {
    const cutoff = new Date(this.time.wallClockMs() - RECONCILE_DELAY_MS);
    const forgotten = await this.prisma.auctionSession.findMany({
      where: {
        status: 'FINISHED',
        finishedAt: { lt: cutoff },
        lot: { deposits: { some: { status: 'ON_SPECIAL_ACCOUNT' } } },
      },
      select: { id: true, lotId: true },
      take: BATCH_SIZE,
    });

    let opened = 0;
    for (const session of forgotten) {
      const top = await this.prisma.bid.findFirst({
        where: { sessionId: session.id },
        orderBy: { seq: 'desc' },
        select: { userId: true },
      });

      if (top === null && (await this.hadBids(session.lotId))) {
        this.logger.warn(
          `Лот ${session.lotId}: цена росла, но ставок в базе нет — ` +
            'возвраты отложены до появления победителя',
        );
        continue;
      }

      opened += await this.deposits.openRefundsForLot(session.lotId, top?.userId ?? null);
    }

    if (opened > 0) {
      this.logger.warn(`Сверка возвратов: открыто задним числом ${String(opened)}`);
    }
    return opened;
  }

  /** Росла ли цена лота — значит ставки были, даже если строк ещё нет. */
  private async hadBids(lotId: string): Promise<boolean> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: lotId },
      select: { startPriceTiyn: true, currentPriceTiyn: true },
    });
    return lot?.currentPriceTiyn != null && lot.currentPriceTiyn > lot.startPriceTiyn;
  }

  /**
   * Задатки, по которым сутки истекли, а банк возврат не подтвердил.
   *
   * Само по себе это не чинится кодом: деньги у банка. Но молчать нельзя —
   * нарушение SLA из ТЗ должно быть видно как инцидент, а не всплывать
   * обращением участника.
   */
  async overdue(): Promise<number> {
    const overdue = await this.prisma.deposit.count({
      where: {
        status: 'REFUND_PENDING',
        refundDeadlineAt: { lt: new Date(this.time.wallClockMs()) },
      },
    });
    if (overdue > 0) {
      this.logger.error(`Просрочен возврат задатков: ${String(overdue)} — SLA 24 ч нарушен`);
    }
    return overdue;
  }
}
