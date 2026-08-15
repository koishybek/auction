import type { DepositView } from '@auction/shared';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  BANK_PROVIDER,
  type BankProvider,
  type BankWebhookEvent,
} from '../integrations/bank/bank.types';
import { PrismaService } from '../prisma/prisma.service';

import { DepositsService } from './deposits.service';

/**
 * Спецдепозитарный счёт платформы (ТЗ §5.2).
 *
 * Заглушка до договора с банком (ОВ-3). Вынесена константой, а не вписана в
 * вызовы: когда реквизит появится, он должен смениться в одном месте, а не
 * в пяти — ошибка здесь означает деньги, ушедшие не туда.
 */
const SPECIAL_ACCOUNT_IBAN = 'KZ00000000000000000000';

/** КБЕ для физлица-резидента. Значение зависит от статуса получателя. */
const KBE_RESIDENT_PERSON = '19';

/**
 * Назначение платежа для задатка.
 *
 * «Без НДС» пишется явно: возврат задатка не облагается налогом, и без этой
 * пометки банк проведёт поручение как оборот (ТЗ §5.2, INT-04).
 */
function depositPurpose(lotId: string): string {
  return `Гарантийный взнос по лоту ${lotId}. Без НДС`;
}

function refundPurpose(lotId: string): string {
  return `Возврат гарантийного взноса по лоту ${lotId}. Без НДС`;
}

/** Чем закончилась обработка вебхука. */
export type WebhookOutcome =
  | { readonly kind: 'APPLIED'; readonly depositId: string }
  | { readonly kind: 'DUPLICATE'; readonly depositId: string }
  | { readonly kind: 'UNKNOWN_REFERENCE' }
  | { readonly kind: 'AMOUNT_MISMATCH'; readonly depositId: string };

/**
 * Платёжная сторона задатка (T-035, INT-03/INT-04).
 *
 * Разделение с DepositsService намеренное: там учёт и статусы, здесь общение с
 * банком. Движок торгов не знает ни о том, ни о другом — он спрашивает только
 * «допущен ли участник» (CLAUDE.md, раздел 3).
 */
@Injectable()
export class DepositPaymentsService {
  private readonly logger = new Logger(DepositPaymentsService.name);

  constructor(
    private readonly deposits: DepositsService,
    private readonly prisma: PrismaService,
    @Inject(BANK_PROVIDER) private readonly bank: BankProvider,
  ) {}

  /**
   * Выставить участнику счёт на задаток.
   *
   * Идентификатором платежа служит id задатка: он уникален для пары «участник
   * + лот» и возвращается банком в вебхуке, по нему платёж и склеивается.
   * Повторный вызов не плодит задатков и просто выставляет счёт заново —
   * человек мог потерять ссылку.
   */
  async requestPayment(input: { lotId: string; userId: string }): Promise<DepositView> {
    const deposit = await this.deposits.open(input);

    const invoice = await this.bank.createInvoice({
      reference: deposit.id,
      amountTiyn: deposit.amountTiyn,
      iban: SPECIAL_ACCOUNT_IBAN,
      kbe: KBE_RESIDENT_PERSON,
      purpose: depositPurpose(input.lotId),
    });

    await this.prisma.deposit.updateMany({
      where: { id: deposit.id, bankRef: null },
      data: { bankRef: invoice.invoiceId },
    });

    // Наружу уходит только view: id задатка и тиыны — внутренние величины,
    // а bigint в JSON не сериализуется вовсе (CLAUDE.md §4.1).
    const view = await this.deposits.view(input);
    return { ...view, payUrl: invoice.payUrl };
  }

  /**
   * Заблокировать сумму на карте (hold-эквайринг, ТЗ §5.2).
   *
   * Блокировка — не зачисление: деньги видны банку, но не лежат на спецсчёте,
   * поэтому к торгам такой задаток ещё не допускает (статус HELD). Перевод на
   * спецсчёт делает банк отдельным событием.
   */
  async holdCard(input: {
    lotId: string;
    userId: string;
    cardToken: string;
  }): Promise<DepositView> {
    const deposit = await this.deposits.open({ lotId: input.lotId, userId: input.userId });

    const hold = await this.bank.holdCard({
      reference: deposit.id,
      amountTiyn: deposit.amountTiyn,
      cardToken: input.cardToken,
    });

    if (deposit.status === 'PENDING') {
      await this.deposits.transition({
        depositId: deposit.id,
        to: 'HELD',
        actor: 'BANK',
        actorId: null,
        reason: `блокировка ${hold.holdId}`,
      });
    }
    return this.deposits.view({ lotId: input.lotId, userId: input.userId });
  }

  /** Поручение на возврат задатка со спецсчёта (INT-04). */
  async requestRefund(depositId: string, iban: string): Promise<string> {
    const deposit = await this.prisma.deposit.findUnique({ where: { id: depositId } });
    if (deposit === null) {
      throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND' });
    }

    const result = await this.bank.refund({
      reference: deposit.id,
      amountTiyn: deposit.amountTiyn,
      iban,
      kbe: KBE_RESIDENT_PERSON,
      purpose: refundPurpose(deposit.lotId),
    });
    this.logger.log(`Задаток ${deposit.id}: поручение на возврат ${result.refundId}`);
    return result.refundId;
  }

  /**
   * Обработать вебхук банка.
   *
   * Идемпотентность даёт статусная машина, а не журнал доставленных событий:
   * банк повторяет вебхук, пока не получит подтверждения, и второй раз перевод
   * в тот же статус просто нечему делать. Заводить отдельную таблицу
   * обработанных событий значило бы держать вторую правду о том, что уже
   * случилось.
   *
   * Сумма сверяется обязательно. Платёж не на ту сумму — не повод допустить
   * участника к торгам: недоплаченный задаток не задаток.
   */
  async handleWebhook(event: BankWebhookEvent): Promise<WebhookOutcome> {
    const deposit = await this.prisma.deposit.findUnique({ where: { id: event.reference } });
    if (deposit === null) {
      // Чужой или устаревший вебхук. Молчать нельзя: это либо ошибка склейки,
      // либо чужой платёж, попавший к нам.
      this.logger.warn(`Вебхук ${event.eventId}: задаток ${event.reference} не найден`);
      return { kind: 'UNKNOWN_REFERENCE' };
    }

    if (event.type === 'payment.failed') {
      this.logger.warn(`Задаток ${deposit.id}: платёж не прошёл`);
      return { kind: 'APPLIED', depositId: deposit.id };
    }

    if (event.amountTiyn !== deposit.amountTiyn) {
      this.logger.error(
        `Задаток ${deposit.id}: пришло ${String(event.amountTiyn)} вместо ` +
          `${String(deposit.amountTiyn)} тиын — к торгам не допускаем`,
      );
      return { kind: 'AMOUNT_MISMATCH', depositId: deposit.id };
    }

    const target = event.type === 'payment.succeeded' ? 'ON_SPECIAL_ACCOUNT' : 'REFUNDED';
    if (deposit.status === target) {
      // Повторная доставка того же события — штатная ситуация, а не ошибка.
      return { kind: 'DUPLICATE', depositId: deposit.id };
    }

    await this.deposits.transition({
      depositId: deposit.id,
      to: target,
      actor: 'BANK',
      actorId: null,
      reason: `вебхук ${event.eventId}`,
    });
    return { kind: 'APPLIED', depositId: deposit.id };
  }
}
