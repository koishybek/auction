import { toTenge, tiyn } from '@auction/shared';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { BankMockProvider } from '../integrations/bank/bank.mock.provider';
import {
  BANK_PROVIDER,
  type BankProvider,
  type BankWebhookEvent,
  type SplitPart,
} from '../integrations/bank/bank.types';
import { isUniqueViolation } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

import { splitPayment } from './splitter';

/** Реквизиты платформы и залогодержателя — заглушки до договора с банком (ОВ-3). */
const PLATFORM_ACCOUNT_IBAN = 'KZ00000000000000000001';
const LIEN_ACCOUNT_IBAN = 'KZ00000000000000000002';
const SELLER_ACCOUNT_IBAN = 'KZ00000000000000000003';
const KBE_LEGAL_ENTITY = '17';

/**
 * Доплата победителя и её расщепление (T-046, INT-03).
 *
 * Задаток победителя уже лежит на спецсчёте, поэтому доплата — это разница
 * между итоговой ценой и внесённым задатком, а не «90 % от цены»: цена за
 * время торгов выросла, а задаток считался от стартовой. Формулировка ТЗ
 * «90 % доплаты» описывает типичный случай, а не формулу — см. ОВ-15.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BANK_PROVIDER) private readonly bank: BankProvider,
  ) {}

  /**
   * Открыть доплату победителю после подтверждения сделки.
   *
   * Идемпотентно: на лот одна доплата. Победитель берётся из победившей ставки,
   * а она проставляется вместе с протоколом (T-044) — до этого момента платить
   * ещё некому.
   */
  async openForWinner(lotId: string): Promise<{ paymentId: string; amountTiyn: bigint } | null> {
    const existing = await this.prisma.payment.findUnique({
      where: { lotId },
      select: { id: true, amountTiyn: true, invoiceRef: true },
    });
    if (existing !== null) {
      // Строка есть — но счёт мог не уйти: банк отвечает по сети, и отказ
      // приходится ровно на момент, когда лот уже переведён в CLOSED. Раньше
      // этот путь возвращался молча, и победитель не получал счёта никогда.
      await this.ensureInvoice({
        paymentId: existing.id,
        lotId,
        amountTiyn: existing.amountTiyn,
        invoiceRef: existing.invoiceRef,
      });
      return { paymentId: existing.id, amountTiyn: existing.amountTiyn };
    }

    const session = await this.prisma.auctionSession.findFirst({
      where: { lotId, status: 'FINISHED' },
      orderBy: { finishedAt: 'desc' },
      include: { winnerBid: { select: { userId: true, amountTiyn: true } }, lot: true },
    });
    if (session?.winnerBid == null) {
      // Торги без победителя: доплачивать некому и незачем.
      return null;
    }

    const deposit = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId: session.winnerBid.userId, lotId } },
      select: { amountTiyn: true, status: true },
    });
    // Зачитывается только задаток, реально лежащий на спецсчёте: заблокированный
    // на карте или уже возвращённый деньгами платформы не является.
    const creditedTiyn = deposit?.status === 'ON_SPECIAL_ACCOUNT' ? deposit.amountTiyn : 0n;
    const amountTiyn = session.winnerBid.amountTiyn - creditedTiyn;

    // Уникальный ключ по лоту не даст создать вторую доплату, даже если два
    // подтверждения сделки придут одновременно. Проигравшая гонку сторона
    // читает чужую строку и работает с ней, а не падает.
    const payment = await this.prisma.payment
      .create({
        data: {
          lotId,
          winnerUserId: session.winnerBid.userId,
          amountTiyn: amountTiyn > 0n ? amountTiyn : 0n,
          status: 'PENDING',
        },
        select: { id: true, amountTiyn: true, invoiceRef: true },
      })
      .catch(async (error: unknown) => {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        return await this.prisma.payment.findUniqueOrThrow({
          where: { lotId },
          select: { id: true, amountTiyn: true, invoiceRef: true },
        });
      });

    await this.ensureInvoice({
      paymentId: payment.id,
      lotId,
      amountTiyn: payment.amountTiyn,
      invoiceRef: payment.invoiceRef,
    });

    this.logger.log(
      `Лот ${lotId}: победителю выставлена доплата ${String(payment.amountTiyn / 100n)} ₸`,
    );
    return { paymentId: payment.id, amountTiyn: payment.amountTiyn };
  }

  /**
   * Выставить счёт, если он ещё не выставлен.
   *
   * Факт отправки — это `invoice_ref` в базе, а не то, что вызов однажды
   * состоялся. Разница видна ровно в том случае, ради которого всё написано:
   * лот закрыт необратимо, а банк на счёт ответил ошибкой. Тогда строка доплаты
   * есть, ссылки нет, и повторный заход (или сверка) доводит дело до конца.
   */
  private async ensureInvoice(input: {
    paymentId: string;
    lotId: string;
    amountTiyn: bigint;
    invoiceRef: string | null;
  }): Promise<void> {
    if (input.invoiceRef !== null && input.invoiceRef !== '') {
      return;
    }
    const invoice = await this.bank.createInvoice({
      reference: input.paymentId,
      amountTiyn: input.amountTiyn,
      iban: PLATFORM_ACCOUNT_IBAN,
      kbe: KBE_LEGAL_ENTITY,
      purpose: `Доплата по лоту ${input.lotId}`,
    });
    await this.prisma.payment.update({
      where: { id: input.paymentId },
      data: { invoiceRef: invoice.invoiceId },
    });
  }

  /**
   * Сверка: доплаты, счёт по которым так и не ушёл в банк.
   *
   * Нужна по той же причине, что и сверка возвратов: подтверждение сделки —
   * обычный код, а банк — сеть. Без сверки лот остаётся закрытым со счётом,
   * которого нет, и узнать об этом можно только от победителя, который ждёт
   * реквизиты. Возвращает число доведённых до конца.
   */
  async retryMissingInvoices(limit = 20): Promise<number> {
    const pending = await this.prisma.payment.findMany({
      where: { status: 'PENDING', invoiceRef: null },
      select: { id: true, lotId: true, amountTiyn: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let sent = 0;
    for (const payment of pending) {
      try {
        await this.ensureInvoice({
          paymentId: payment.id,
          lotId: payment.lotId,
          amountTiyn: payment.amountTiyn,
          invoiceRef: null,
        });
        sent += 1;
        this.logger.warn(`Лот ${payment.lotId}: счёт на доплату выставлен повторным заходом`);
      } catch (error) {
        this.logger.error(
          `Лот ${payment.lotId}: счёт на доплату так и не ушёл — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return sent;
  }

  /** Сколько доплат ждут счёта. Ноль — норма. */
  async missingInvoiceCount(): Promise<number> {
    return await this.prisma.payment.count({ where: { status: 'PENDING', invoiceRef: null } });
  }

  /**
   * Вебхук банка по доплате.
   *
   * Идемпотентность держат две вещи: статус платежа (повторный вебхук видит
   * PAID и уходит) и уникальный ключ на паре «платёж + вид доли» в базе. Второе
   * важнее: даже если два вебхука доедут одновременно, второго поручения того
   * же вида не появится — это ограничение БД, а не порядок вызовов.
   */
  async handleWebhook(event: BankWebhookEvent): Promise<'APPLIED' | 'DUPLICATE' | 'UNKNOWN'> {
    const payment = await this.prisma.payment.findUnique({ where: { id: event.reference } });
    if (payment === null) {
      return 'UNKNOWN';
    }
    if (event.type === 'payment.failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      return 'APPLIED';
    }
    if (payment.status === 'PAID') {
      return 'DUPLICATE';
    }
    if (event.amountTiyn !== payment.amountTiyn) {
      this.logger.error(
        `Доплата ${payment.id}: пришло ${String(event.amountTiyn)} вместо ` +
          `${String(payment.amountTiyn)} тиын — расщепление не запускаем`,
      );
      return 'APPLIED';
    }

    await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'PAID', bankRef: event.eventId },
    });
    await this.split(payment.id);
    return 'APPLIED';
  }

  /**
   * Расщепить оплаченную доплату и отправить поручения.
   *
   * Записи о долях создаются ДО поручений в банк: поручение, отправленное без
   * записи, — это деньги, ушедшие без следа. Обратный порядок при сбое между
   * шагами оставил бы запись без перевода, и это чинится повтором, а не
   * разбирательством с банком.
   */
  async split(paymentId: string): Promise<number> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { lot: true },
    });
    if (payment === null) {
      throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND' });
    }
    if (payment.status !== 'PAID') {
      throw new ConflictException({ code: 'PAYMENT_NOT_PAID' });
    }

    const finalPriceTiyn = payment.lot.currentPriceTiyn ?? payment.lot.startPriceTiyn;
    const parts = splitPayment({
      paymentTiyn: payment.amountTiyn,
      finalPriceTiyn,
      lienDebtTiyn: payment.lot.lienDebtTiyn,
    });

    const rows: { kind: 'FEE_5PCT' | 'BANK_DEBT' | 'SELLER_REST'; amountTiyn: bigint }[] = [
      { kind: 'FEE_5PCT', amountTiyn: parts.feeTiyn },
      { kind: 'BANK_DEBT', amountTiyn: parts.bankDebtTiyn },
      { kind: 'SELLER_REST', amountTiyn: parts.sellerRestTiyn },
    ];

    // Уникальный ключ «платёж + вид» не даст создать вторую долю того же вида
    // ни при повторном вебхуке, ни при двух одновременных.
    const created = await this.prisma.payoutSplit.createMany({
      data: rows.map((row) => ({ paymentId, kind: row.kind, amountTiyn: row.amountTiyn })),
      skipDuplicates: true,
    });
    if (created.count === 0) {
      // Доли уже были: повторный вебхук поручений не порождает.
      return 0;
    }

    // Вид доли идёт рядом с поручением, а не отдельным списком: нулевые
    // поручения в банк не уходят, и после фильтра порядок в списке перестаёт
    // совпадать с порядком строк в базе.
    type PayoutOrder = { kind: 'FEE_5PCT' | 'BANK_DEBT' | 'SELLER_REST'; part: SplitPart };
    const orders: PayoutOrder[] = (
      [
        {
          kind: 'FEE_5PCT',
          part: {
            iban: PLATFORM_ACCOUNT_IBAN,
            kbe: KBE_LEGAL_ENTITY,
            amountTiyn: parts.feeTiyn,
            purpose: `Комиссия платформы 5 % по лоту ${payment.lotId}`,
          },
        },
        {
          kind: 'BANK_DEBT',
          part: {
            iban: LIEN_ACCOUNT_IBAN,
            kbe: KBE_LEGAL_ENTITY,
            amountTiyn: parts.bankDebtTiyn,
            purpose: `Погашение задолженности залогодержателю по лоту ${payment.lotId}`,
          },
        },
        {
          kind: 'SELLER_REST',
          part: {
            iban: SELLER_ACCOUNT_IBAN,
            kbe: KBE_LEGAL_ENTITY,
            amountTiyn: parts.sellerRestTiyn,
            purpose: `Расчёт с продавцом по лоту ${payment.lotId}`,
          },
        },
      ] satisfies PayoutOrder[]
    ).filter((order) => order.part.amountTiyn > 0n);

    const result = await this.bank.split({
      reference: paymentId,
      parts: orders.map((order) => order.part),
    });

    /**
     * У каждой доли свой идентификатор перевода.
     *
     * Банк возвращает `partIds` — по одному на часть, в том же порядке, что
     * пришли поручения. Раньше во все три строки писался общий `splitId`, и при
     * отказе одного перевода из трёх сверить его с банковской выпиской было
     * нечем: у отклонённого и у прошедших один и тот же номер. Спор о неполученных
     * деньгах продавца разбирается именно по номеру операции.
     */
    for (const [index, order] of orders.entries()) {
      await this.prisma.payoutSplit.updateMany({
        where: { paymentId, kind: order.kind },
        data: { status: 'SENT', bankRef: result.partIds[index] ?? result.splitId },
      });
    }

    // Нулевая доля в банк не уходила, поручения у неё нет — и номера операции
    // тоже. Статус всё равно закрывается: строка не должна висеть в ожидании
    // перевода, которого не будет.
    await this.prisma.payoutSplit.updateMany({
      where: { paymentId, status: 'PENDING' },
      data: { status: 'SENT' },
    });

    this.logger.log(
      `Доплата ${paymentId} расщеплена: комиссия ${String(toTenge(tiyn(parts.feeTiyn)))} ₸, ` +
        `залог ${String(toTenge(tiyn(parts.bankDebtTiyn)))} ₸, ` +
        `продавцу ${String(toTenge(tiyn(parts.sellerRestTiyn)))} ₸`,
    );
    return created.count;
  }

  /**
   * Эмуляция оплаты доплаты (только вне production).
   *
   * Та же причина, что у задатка: настоящего банка нет (ОВ-3), а без
   * плательщика вся вторая половина денежного контура непроверяема.
   */
  async devPay(paymentId: string): Promise<'APPLIED' | 'DUPLICATE' | 'UNKNOWN'> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { amountTiyn: true },
    });
    if (payment === null) {
      throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND' });
    }
    if (!(this.bank instanceof BankMockProvider)) {
      throw new NotFoundException({ code: 'BANK_NOT_MOCKED' });
    }
    return this.handleWebhook(this.bank.emitPayment(paymentId, payment.amountTiyn));
  }
}
