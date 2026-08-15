/**
 * Контракт банковского провайдера (INT-03, INT-04, ОВ-3).
 *
 * Банк-партнёр не назван, договора нет — по ОВ-3 решено делать абстракцию и
 * мок. Здесь зафиксировано ровно то, что требует ТЗ §5.2: быстрые инвойсы по
 * IBAN, hold-эквайринг, платёжное поручение со спецсчёта с КБЕ и назначением
 * без НДС, и расщепление доплаты победителя.
 *
 * Суммы всюду в ТИЫНАХ (CLAUDE.md §4.2). Ни один метод не принимает дробных
 * чисел: у банка это привело бы к расхождению в копейку, которая потом
 * превращается в спор.
 */

/**
 * Код бенефициара — обязательный реквизит платежа в Казахстане.
 * Для возврата задатка физлицу-резиденту это 19; значение задаётся вызывающим,
 * потому что оно зависит от статуса получателя, а не от нашей логики.
 */
export type Kbe = string;

export interface InvoiceRequest {
  /** Наш идентификатор — по нему приходит вебхук и склеивается платёж. */
  readonly reference: string;
  readonly amountTiyn: bigint;
  /** Счёт, на который платит участник. Для задатка — спецдепозитарный. */
  readonly iban: string;
  readonly kbe: Kbe;
  /** Назначение платежа. Для задатка — без НДС (ТЗ §5.2). */
  readonly purpose: string;
}

export interface InvoiceResult {
  readonly invoiceId: string;
  /** Ссылка или QR для оплаты — то, что показывается участнику. */
  readonly payUrl: string;
}

export interface HoldRequest {
  readonly reference: string;
  readonly amountTiyn: bigint;
  /** Токен карты от эквайринга. Номер карты к нам не попадает никогда. */
  readonly cardToken: string;
}

export interface HoldResult {
  readonly holdId: string;
}

export interface RefundRequest {
  readonly reference: string;
  readonly amountTiyn: bigint;
  /** Куда возвращаем: счёт участника. */
  readonly iban: string;
  readonly kbe: Kbe;
  /**
   * Назначение платежа. Возврат задатка НДС не облагается, и это должно быть
   * написано в поручении явно — иначе банк проведёт его как оборот (ТЗ §5.2).
   */
  readonly purpose: string;
}

export interface RefundResult {
  readonly refundId: string;
}

/** Одна доля расщепления доплаты победителя (INT-03, Payment Splitter). */
export interface SplitPart {
  readonly iban: string;
  readonly kbe: Kbe;
  readonly amountTiyn: bigint;
  readonly purpose: string;
}

export interface SplitRequest {
  readonly reference: string;
  readonly parts: readonly SplitPart[];
}

export interface SplitResult {
  readonly splitId: string;
  readonly partIds: readonly string[];
}

export interface BankProvider {
  createInvoice(request: InvoiceRequest): Promise<InvoiceResult>;
  holdCard(request: HoldRequest): Promise<HoldResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  split(request: SplitRequest): Promise<SplitResult>;
}

export const BANK_PROVIDER = Symbol('BANK_PROVIDER');

/** Что банк сообщает вебхуком. Наружу приходит именно это, не больше. */
export const BANK_EVENTS = ['payment.succeeded', 'payment.failed', 'refund.succeeded'] as const;
export type BankEventType = (typeof BANK_EVENTS)[number];

export interface BankWebhookEvent {
  /** Идентификатор события у банка. По нему отсекается повторная доставка. */
  readonly eventId: string;
  readonly type: BankEventType;
  /** Наш reference из запроса — по нему находится задаток. */
  readonly reference: string;
  readonly amountTiyn: bigint;
}
