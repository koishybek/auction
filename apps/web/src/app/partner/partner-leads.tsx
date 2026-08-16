'use client';

import type {
  PartnerLeadView,
  PartnerLeadsView,
  RefBonusView,
  RefBonusesView,
} from '@auction/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PhaseRatchet, phaseLabel } from '@/components/phase-ratchet';
import { formatTenge } from '@/lib/format';

/** Как часто пересчитывается прогноз. Цена растёт ставками, а не мгновенно. */
const BONUS_REFRESH_MS = 5_000;

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

      <RefBonus />
    </>
  );
}

/**
 * Ref-Bonus: 2 % от победной цены (FR-19).
 *
 * Пока торги идут, это прогноз, и он обновляется опросом вместе с ценой.
 * Считает его сервер — здесь нет ни процента, ни округления: вторая
 * арифметика в браузере означала бы, что партнёр видит одну сумму, а получает
 * другую.
 */
function RefBonus() {
  const [items, setItems] = useState<readonly RefBonusView[] | null>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      const response = await fetch('/api/partner/ref-bonus', {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        setItems(((await response.json()) as RefBonusesView).items);
      }
    };
    void load();
    const timer = setInterval(() => void load(), BONUS_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  if (items === null || items.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="bonus-title" className="mt-20">
      <h2 id="bonus-title" className="eyebrow mb-6">
        Ref-Bonus · 2 % от победной цены
      </h2>
      <ul className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
        {items.map((bonus) => (
          <li key={bonus.lotId} className="flex items-baseline justify-between gap-4 py-5">
            <span className="tabular text-sm text-[var(--color-muted)]">{bonus.cadastreOrVin}</span>
            <span className="text-right">
              <span className="tabular block text-lg text-[var(--color-value)]">
                {formatTenge(bonus.amountTenge)}
              </span>
              <span className="eyebrow">{bonusLabel(bonus.status)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function bonusLabel(status: RefBonusView['status']): string {
  if (status === 'FORECAST') return 'прогноз · торги идут';
  if (status === 'ACCRUED') return 'начислено · ожидает выплаты';
  return 'выплачено на Счёт А';
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
