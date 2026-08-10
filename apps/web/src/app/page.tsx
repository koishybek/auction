import { CONTRACT_VERSION } from '@auction/shared';

import { getLiveness, getReadiness } from '@/lib/api-client';

import { HealthPanel } from './health-panel';

// Страница рендерится на каждый запрос: состояние бэкенда кэшировать бессмысленно.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [liveness, readiness] = await Promise.all([getLiveness(), getReadiness()]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header>
        <p className="mb-2 text-xs tracking-[0.2em] text-[var(--color-accent)] uppercase">
          Phase 0 · каркас
        </p>
        <h1 className="text-2xl font-semibold text-balance">
          Цифровой гибридный аукцион скоростных продаж
        </h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Шаг ставки +3 %, таймер 50 секунд, задаток 10 %, анонимные участники. Торгов ещё нет — это
          проверка того, что фронт, бэк и общие типы собраны вместе.
        </p>
      </header>

      <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-soft)] p-5">
        <h2 className="mb-4 text-sm font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Отрисовано на сервере
        </h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-muted)]">Версия контракта</dt>
            <dd className="font-mono">{CONTRACT_VERSION}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-muted)]">GET /health</dt>
            <dd className="font-mono">
              {liveness.ok ? (
                <span className="text-[var(--color-up)]">
                  {liveness.data.status} · uptime {String(liveness.data.uptimeSec)} с
                </span>
              ) : (
                <span className="text-[var(--color-down)]">{liveness.error}</span>
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-muted)]">GET /health/ready</dt>
            <dd className="font-mono">
              {readiness.ok ? (
                <span
                  className={
                    readiness.data.status === 'up'
                      ? 'text-[var(--color-up)]'
                      : 'text-[var(--color-down)]'
                  }
                >
                  {readiness.data.status}
                </span>
              ) : (
                <span className="text-[var(--color-down)]">{readiness.error}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <HealthPanel
        initialReport={readiness.ok ? readiness.data : null}
        initialError={readiness.ok ? null : readiness.error}
      />
    </main>
  );
}
