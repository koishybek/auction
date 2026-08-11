import { CONTRACT_VERSION } from '@auction/shared';
import type { Metadata } from 'next';

import { getLiveness, getReadiness } from '@/lib/api-client';

import { HealthPanel } from './health-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Состояние систем',
  description: 'Техническое состояние торгового сервера и его зависимостей.',
  // Служебная страница в поиске не нужна.
  robots: { index: false, follow: false },
};

export default async function StatusPage() {
  const [liveness, readiness] = await Promise.all([getLiveness(), getReadiness()]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="eyebrow mb-4">Служебная страница</p>
      <h1 className="font-serif text-3xl">Состояние систем</h1>
      <p className="mt-4 text-sm text-[var(--color-muted)]">
        Проверка того, что торговый сервер и его зависимости отвечают. Данные снимаются на сервере
        при каждом запросе.
      </p>

      <section className="mt-12 border-t border-[var(--color-rule)] pt-8">
        <h2 className="eyebrow mb-5">Отрисовано на сервере</h2>
        <dl className="space-y-3 text-sm">
          <Row term="Версия контракта" value={CONTRACT_VERSION} />
          <Row
            term="GET /api/health"
            value={
              liveness.ok
                ? `${liveness.data.status} · ${String(liveness.data.uptimeSec)} с`
                : liveness.error
            }
            ok={liveness.ok}
          />
          <Row
            term="GET /api/health/ready"
            value={readiness.ok ? readiness.data.status : readiness.error}
            ok={readiness.ok && readiness.data.status === 'up'}
          />
        </dl>
      </section>

      <div className="mt-10">
        <HealthPanel
          initialReport={readiness.ok ? readiness.data : null}
          initialError={readiness.ok ? null : readiness.error}
        />
      </div>
    </main>
  );
}

function Row({ term, value, ok }: { term: string; value: string; ok?: boolean }) {
  const color =
    ok === undefined
      ? 'text-[var(--color-paper)]'
      : ok
        ? 'text-[var(--color-signal)]'
        : 'text-[var(--color-alert)]';
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-[var(--color-rule)] pb-3">
      <dt className="text-[var(--color-muted)]">{term}</dt>
      <dd className={`tabular text-right ${color}`}>{value}</dd>
    </div>
  );
}
