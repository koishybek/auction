import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type {
  BankProvider,
  BankWebhookEvent,
  HoldRequest,
  HoldResult,
  InvoiceRequest,
  InvoiceResult,
  RefundRequest,
  RefundResult,
  SplitRequest,
  SplitResult,
} from './bank.types';

/**
 * Мок банка (ОВ-3).
 *
 * Настоящего банка нет, поэтому здесь тот же приём, что у eGov и реестра:
 * записываем всё, что просили сделать, и умеем породить вебхук — банк ведь
 * отвечает не в ответе на запрос, а отдельным обращением к нам.
 *
 * Отказ включается точечно: платёж, который не прошёл, — это половина
 * банковского контура, и проверять её нужно так же, как успех.
 */
@Injectable()
export class BankMockProvider implements BankProvider {
  private readonly logger = new Logger(BankMockProvider.name);
  private readonly invoices: InvoiceRequest[] = [];
  private readonly holds: HoldRequest[] = [];
  private readonly refunds: RefundRequest[] = [];
  private readonly splits: SplitRequest[] = [];
  private failNext = false;

  createInvoice(request: InvoiceRequest): Promise<InvoiceResult> {
    this.invoices.push(request);
    const invoiceId = `inv-${randomUUID()}`;
    // Реквизиты и суммы в лог не пишем: платёжные данные живут не дольше запроса.
    this.logger.debug(`Инвойс ${invoiceId} по ссылке ${request.reference}`);
    return Promise.resolve({ invoiceId, payUrl: `https://bank.mock/pay/${invoiceId}` });
  }

  holdCard(request: HoldRequest): Promise<HoldResult> {
    this.holds.push(request);
    return Promise.resolve({ holdId: `hold-${randomUUID()}` });
  }

  refund(request: RefundRequest): Promise<RefundResult> {
    this.refunds.push(request);
    return Promise.resolve({ refundId: `ref-${randomUUID()}` });
  }

  split(request: SplitRequest): Promise<SplitResult> {
    this.splits.push(request);
    return Promise.resolve({
      splitId: `split-${randomUUID()}`,
      partIds: request.parts.map(() => `part-${randomUUID()}`),
    });
  }

  /**
   * Породить вебхук так, как это сделал бы банк.
   *
   * Отдельный метод, а не автоматический ответ на инвойс: в жизни между
   * выставлением счёта и оплатой проходит время, и код обязан это переживать.
   */
  emitPayment(reference: string, amountTiyn: bigint): BankWebhookEvent {
    const failed = this.failNext;
    this.failNext = false;
    return {
      eventId: `evt-${randomUUID()}`,
      type: failed ? 'payment.failed' : 'payment.succeeded',
      reference,
      amountTiyn,
    };
  }

  emitRefund(reference: string, amountTiyn: bigint): BankWebhookEvent {
    return { eventId: `evt-${randomUUID()}`, type: 'refund.succeeded', reference, amountTiyn };
  }

  /** Следующий платёж не пройдёт. */
  failPaymentOnce(): void {
    this.failNext = true;
  }

  invoicesSent(): readonly InvoiceRequest[] {
    return this.invoices;
  }

  refundsSent(): readonly RefundRequest[] {
    return this.refunds;
  }

  holdsSent(): readonly HoldRequest[] {
    return this.holds;
  }

  splitsSent(): readonly SplitRequest[] {
    return this.splits;
  }

  reset(): void {
    this.invoices.length = 0;
    this.holds.length = 0;
    this.refunds.length = 0;
    this.splits.length = 0;
    this.failNext = false;
  }
}
