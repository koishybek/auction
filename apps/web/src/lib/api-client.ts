import type { LivenessReport, ReadinessReport } from '@auction/shared';

/**
 * Клиент API. Типы ответов берутся из @auction/shared — того же пакета, который
 * реализует бэкенд. Разъедутся контракты — не соберётся ни api, ни web.
 */

const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:3100';

export type ApiResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

async function request<T>(path: string, timeoutMs = 5_000): Promise<ApiResult<T>> {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      signal: abort,
      // Состояние здоровья не кэшируем: смысл ручки в том, чтобы показать «сейчас».
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });

    // 503 у readiness — валидный ответ с телом, а не сбой запроса.
    const payload: unknown = await response.json();
    if (!response.ok && response.status !== 503) {
      return { ok: false, error: `HTTP ${String(response.status)}` };
    }
    return { ok: true, data: payload as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function getLiveness(): Promise<ApiResult<LivenessReport>> {
  return request<LivenessReport>('/health');
}

export function getReadiness(): Promise<ApiResult<ReadinessReport>> {
  return request<ReadinessReport>('/health/ready');
}

export { API_BASE_URL };
