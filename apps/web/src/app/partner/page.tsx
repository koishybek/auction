import type { Metadata } from 'next';

import { PartnerLeads } from './partner-leads';

export const metadata: Metadata = {
  title: 'Кабинет партнёра',
  robots: { index: false, follow: false },
};

/**
 * Кабинет партнёра-риелтора (T-042, FR-18).
 *
 * Партнёр приводит собственника и закрепляет объект за собой на 90 дней. Из
 * этого закрепления потом растёт Ref-Bonus, поэтому «занят или нет» здесь —
 * вопрос о деньгах, и отвечает на него сервер.
 */
export default function PartnerPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="mb-12 border-b border-[var(--color-rule)] pb-8">
        <h1 className="font-serif text-4xl">Лиды</h1>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
          Зарегистрируйте объект — и он закрепляется за вами на 90 дней. Занятый объект система не
          отдаст: закрепление на нём одно.
        </p>
      </header>
      <PartnerLeads />
    </main>
  );
}
