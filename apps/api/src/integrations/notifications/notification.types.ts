/**
 * Контракт провайдера уведомлений (INT, ОВ-12).
 *
 * Провайдер SMS/Push в ТЗ не назван — по ОВ-12 выбор отложен до Фазы 4.
 * Поэтому здесь интерфейс и мок, а реальная реализация подключается заменой
 * одного провайдера в модуле: ни один вызывающий код о ней не узнает.
 */

/** Каналы из схемы БД: других способов достучаться до участника у нас нет. */
export type NotificationChannelValue = 'PUSH' | 'SMS';

/**
 * Срочность. Заморозка по SLA идёт HIGH: ТЗ §2.2 требует «приоритетное
 * push/SMS», потому что человек в этот момент смотрит на замерший таймер и
 * должен узнать причину раньше, чем решит, что его обманули.
 */
export type NotificationPriority = 'NORMAL' | 'HIGH';

export interface NotificationRequest {
  readonly userId: string;
  readonly channel: NotificationChannelValue;
  /** Идентификатор шаблона. Текст живёт у провайдера, а не в коде. */
  readonly template: string;
  /** Подстановки шаблона. Только примитивы: это уходит наружу как есть. */
  readonly params: Readonly<Record<string, string | number>>;
  /**
   * Расшифрованный телефон для SMS. `null` — номера нет, канал недоступен.
   *
   * Расшифровка происходит на границе с провайдером и нигде не сохраняется:
   * оператору связи номер нужен, нашей базе — нет (CLAUDE.md §4.5).
   */
  readonly phone: string | null;
  readonly priority: NotificationPriority;
}

export interface NotificationResult {
  readonly delivered: boolean;
  /** Идентификатор у провайдера — по нему разбирают недоставку. */
  readonly externalId?: string;
  readonly error?: string;
}

export interface NotificationProvider {
  send(request: NotificationRequest): Promise<NotificationResult>;
}

export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');
