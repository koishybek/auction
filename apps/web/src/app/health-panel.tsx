'use client';

import type { ReadinessReport } from '@auction/shared';
import { useEffect } from 'react';

import { useHealthStore } from '@/store/health-store';

/**
 * Клиентская часть: получает снимок с сервера и умеет перепроверять.
 * Zustand здесь ради проверки связки — реальная работа стора начнётся
 * в аукционном зале (T-039), где состояние двигают WS-события.
 */
export function HealthPanel({
  initialReport,
  initialError,
}: {
  initialReport: ReadinessReport | null;
  initialError: string | null;
}) {
  const { report, error, checking, checkedAt, hydrate, refresh } = useHealthStore();

  useEffect(() => {
    hydrate(initialReport, initialError);
  }, [hydrate, initialReport, initialError]);

  // До гидратации показываем серверный снимок: иначе первый HTML приходит пустым
  // и список зависимостей появляется рывком только после запуска JS.
  const shown = report ?? initialReport;
  const shownError = report === null ? (error ?? initialError) : error;
  const dependencies = Object.entries(shown?.dependencies ?? {});

  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-soft)] p-5">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Состояние бэкенда
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          className="rounded border border-[var(--color-line)] px-3 py-1 text-sm text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
        >
          {checking ? 'Проверяю…' : 'Перепроверить'}
        </button>
      </div>

      {shownError !== null && (
        <p className="text-sm text-[var(--color-down)]">API недоступен: {shownError}</p>
      )}

      {dependencies.length > 0 && (
        <ul className="space-y-2">
          {dependencies.map(([name, dependency]) => (
            <li key={name} className="flex items-center justify-between gap-4 text-sm">
              <span className="font-mono">{name}</span>
              <span
                className={
                  dependency.status === 'up' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'
                }
              >
                {dependency.status === 'up'
                  ? `up · ${String(dependency.latencyMs)} мс`
                  : `down · ${dependency.error ?? 'причина не указана'}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {checkedAt !== null && (
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Проверено на клиенте: {new Date(checkedAt).toLocaleTimeString('ru-RU')}
        </p>
      )}
    </section>
  );
}
