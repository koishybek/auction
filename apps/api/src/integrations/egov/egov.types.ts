/**
 * Контракт провайдера eGov Digital ID (INT-01).
 *
 * Реального подключения нет и не будет до соглашений с ГИС (риск R-1 плана),
 * поэтому контракт зафиксирован интерфейсом, а реализация — мок с эмуляцией
 * QR-флоу. Настоящий адаптер, когда появятся доступы, обязан лечь в этот же
 * интерфейс — код авторизации при этом не меняется.
 *
 * Флоу (§5.1 ТЗ): пользователь сканирует QR в eGov Mobile → подтверждает
 * (возможно биометрией) → бэкенд получает подтверждённую личность (ИИН, ФИО).
 */

/** Личность, подтверждённая eGov. Приходит ТОЛЬКО от провайдера, не от клиента. */
export interface EgovIdentity {
  readonly iin: string;
  readonly fio: string;
  /** Подтверждение прошло с биометрией (Facial Recognition). */
  readonly biometricConfirmed: boolean;
}

export interface EgovInitResult {
  readonly sessionId: string;
  /** Ссылка, которую клиент показывает как QR. */
  readonly qrUrl: string;
  /** Серверное время истечения сессии, мс. */
  readonly expiresAtMs: number;
}

export type EgovSessionState =
  | { readonly status: 'PENDING' }
  | { readonly status: 'APPROVED'; readonly identity: EgovIdentity }
  | { readonly status: 'DENIED' }
  | { readonly status: 'EXPIRED' }
  /** Уже обменяна на вход — второй раз токены по ней не выдаются. */
  | { readonly status: 'CONSUMED' };

export interface EgovProvider {
  /** Начать QR-флоу. */
  initQr(): Promise<EgovInitResult>;
  /** Текущее состояние сессии. Не мутирует состояние. */
  check(sessionId: string): Promise<EgovSessionState>;
  /**
   * Атомарно забрать подтверждённую личность и пометить сессию использованной.
   * Возвращает null, если сессия не в состоянии APPROVED, — повторный обмен
   * той же сессии невозможен.
   */
  consume(sessionId: string): Promise<EgovIdentity | null>;
}

/** DI-токен: авторизация зависит от интерфейса, не от конкретного мока. */
export const EGOV_PROVIDER = Symbol('EGOV_PROVIDER');
