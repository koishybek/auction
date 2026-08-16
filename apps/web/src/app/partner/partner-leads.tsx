'use client';

import type { PartnerLeadView, PartnerLeadsView } from '@auction/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PhaseRatchet, phaseLabel } from '@/components/phase-ratchet';

/**
 * Лиды партнёра: форма регистрации и список закреплений.
 *
 * Занятость проверяет сервер — форма только показывает его ответ словами.
 * Проверять «свободен ли объект» здесь значило бы завести второй ответ на
 * вопрос, за кем закреплены будущие 2 %.
 */

const REJECT_TEXT: Readonly<Record<string, string>> = {
  TAKEN: 'Объект уже закреплён за другим партнёром.',
  ALREADY_ON_PLATFORM: 'Объект уже продаётся на площадке — закреплять нечего.',
};

/** Значение поля формы. `FormData` отдаёт ещё и файлы — их здесь быть не может. */
function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Дней до конца закрепления. Часы и минуты партнёру не нужны: срок — 90 дней. */
function daysLeft(remainingMs: number): number {
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

export function PartnerLeads() {
  const [items, setItems] = useState<readonly PartnerLeadView[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/partner/leads', {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      setDenied(true);
      return;
    }
    setDenied(false);
    setItems(((await response.json()) as PartnerLeadsView).items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/partner/leads', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          ownerIin: textField(form, 'ownerIin'),
          ownerPhone: textField(form, 'ownerPhone'),
          cadastreOrVin: textField(form, 'cadastreOrVin'),
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { code?: string };
        setError(REJECT_TEXT[body.code ?? ''] ?? 'Не удалось зарегистрировать лид.');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (denied) {
    return (
      <p className="max-w-prose text-sm text-[var(--color-muted)]">
        Кабинет доступен подтверждённому партнёру.{' '}
        <Link href="/login" className="underline">
          Войти
        </Link>
      </p>
    );
  }

  return (
    <>
      <form onSubmit={(event) => void submit(event)} className="mb-16 grid gap-5 sm:grid-cols-3">
        <Field name="ownerIin" label="ИИН собственника" placeholder="000000000000" />
        <Field name="ownerPhone" label="Телефон" placeholder="+7 701 000 00 00" />
        <Field name="cadastreOrVin" label="Кадастр или VIN" placeholder="20-317-077-1234" />
        <div className="sm:col-span-3">
          <button type="submit" disabled={busy} className="deposit-action">
            Закрепить объект
          </button>
          {error !== null && <p className="mt-4 text-xs text-[var(--color-alert)]">{error}</p>}
        </div>
      </form>

      {items === null ? (
        <p className="text-xs text-[var(--color-muted)]">Загружаем лиды…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">Лидов пока нет.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
          {items.map((lead) => (
            <LeadRow key={lead.id} lead={lead} />
          ))}
        </ul>
      )}
    </>
  );
}

function LeadRow({ lead }: { lead: PartnerLeadView }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-6">
      <div>
        <p className="tabular text-[var(--color-paper)]">{lead.cadastreOrVin}</p>
        {lead.lotStatus !== null && (
          // Прогресс-бар фаз: партнёр видит, куда дошёл приведённый им объект.
          <div className="mt-3 flex items-center gap-3">
            <PhaseRatchet status={lead.lotStatus} />
            <span className="eyebrow">{phaseLabel(lead.lotStatus)}</span>
          </div>
        )}
      </div>

      <div className="text-right">
        {lead.status === 'LOCKED' && lead.lockRemainingMs !== null ? (
          <>
            <p className="eyebrow text-[var(--color-signal)]">Закреплён на 90 дней</p>
            <p className="tabular mt-2 text-sm text-[var(--color-muted)]">
              осталось {String(daysLeft(lead.lockRemainingMs))} дн.
            </p>
          </>
        ) : (
          <p className="eyebrow">{statusLabel(lead.status)}</p>
        )}
      </div>
    </li>
  );
}

function statusLabel(status: PartnerLeadView['status']): string {
  if (status === 'EXPIRED') return 'Закрепление истекло';
  if (status === 'CONVERTED') return 'Объект вышел на площадку';
  return 'Проверен, свободен';
}

function Field({ name, label, placeholder }: { name: string; label: string; placeholder: string }) {
  return (
    <label className="block">
      <span className="eyebrow mb-2 block">{label}</span>
      <input
        name={name}
        placeholder={placeholder}
        required
        className="tabular w-full border border-[var(--color-rule-bright)] bg-transparent px-3 py-2 text-sm text-[var(--color-paper)]"
      />
    </label>
  );
}
