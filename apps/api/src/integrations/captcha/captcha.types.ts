/**
 * Контракт провайдера капчи (ОВ-5).
 *
 * ТЗ называет «Biometric CloudPayer», такого продукта на рынке нет — по ОВ-5
 * принято решение о Cloudflare Turnstile плюс собственная эвристика. Ключей
 * пока нет, поэтому здесь интерфейс, а рабочая реализация — мок; настоящий
 * Turnstile подключается заменой одного провайдера.
 */

export interface CaptchaVerification {
  readonly ok: boolean;
  /** Код отказа провайдера — для лога, не для человека. */
  readonly code?: string;
}

export interface CaptchaProvider {
  /**
   * Проверить токен, выданный виджетом.
   *
   * `remoteIp` передаётся провайдеру: тот же токен, предъявленный с другого
   * адреса, — признак перепродажи решённых капч.
   */
  verify(input: { token: string; remoteIp: string | null }): Promise<CaptchaVerification>;
}

export const CAPTCHA_PROVIDER = Symbol('CAPTCHA_PROVIDER');
