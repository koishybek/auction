'use client';

import type { SellerDashboardView, SellerLotView } from '@auction/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { phaseLabel } from '@/components/phase-ratchet';
import { formatTenge, lotTypeLabel } from '@/lib/format';

/**
 * Монитор прозрачности.
 *
 * Обновляется опросом раз в 5 секунд: во время торгов цифры растут, и
 * страница, требующая перезагрузки, показывала бы вчерашний интерес. Сокет
 * ради этого не нужен — счётчики не про миллисекунды.
 */

const REFRESH_MS = 5_000;

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly items: readonly SellerLotView[] };

export function SellerDashboard() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/seller/lots', {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (response.status === 401 || response.status === 403) {
        setState({ kind: 'anonymous' });
        return;
      }
      if (!response.ok) {
        setState({ kind: 'error', message: `HTTP ${String(response.status)}` });
        return;
      }
      const body = (await response.json()) as SellerDashboardView;
      setState({ kind: 'ready', items: body.items });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Сеть недоступна',
      });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  if (state.kind === 'loading') {
    return <p className="text-xs text-[var(--color-muted)]">Загружаем ваши лоты…</p>;
  }
  if (state.kind === 'anonymous') {
    return (
      <p className="max-w-prose text-sm text-[var(--color-muted)]">
        Кабинет доступен продавцу.{' '}
        <Link href="/login" className="underline">
          Войти
        </Link>
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="text-sm text-[var(--color-alert)]">Не удалось загрузить: {state.message}</p>
    );
  }
  if (state.items.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">Лотов пока нет.</p>;
  }

  return (
    <ul className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
      {state.items.map((lot) => (
        <LotRow key={lot.id} lot={lot} onChanged={() => void load()} />
      ))}
    </ul>
  );
}

function LotRow({ lot, onChanged }: { lot: SellerLotView; onChanged: () => void }) {
  const isLive = lot.status === 'PHASE_III';
  const price = lot.currentPriceTenge ?? lot.startPriceTenge;

  return (
    <li className="py-8">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <Link href={`/lots/${lot.id}`} className="text-lg hover:underline">
            {lotTypeLabel(lot.type)} · {lot.cadastreOrVin}
          </Link>
          <p className="eyebrow mt-2">{phaseLabel(lot.status)}</p>
        </div>
        <div className="text-right">
          <p className="tabular text-2xl text-[var(--color-value)]">{formatTenge(price)}</p>
          {isLive && (
            // Продавец смотрит торги, но не участвует в них: это правило
            // сервера, а не оформление кнопки (FR-16).
            <p className="eyebrow mt-2 text-[var(--color-signal)]">идут торги · только просмотр</p>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-5">
        <Metric term="Просмотры" value={lot.viewsCount} />
        <Metric term="Документы" value={lot.documentsCount} />
        <Metric term="Скачивания" value={lot.downloadsCount} />
        <Metric
          term="Записи на показ"
          value={`${String(lot.openHouseBookings)} / ${String(lot.openHouseSlots)}`}
        />
        <Metric term="Ставки" value={lot.bidsCount} />
      </dl>

      {lot.status === 'FINISHED' && <Decision lotId={lot.id} onChanged={onChanged} />}
    </li>
  );
}

/**
 * Решение продавца после торгов (FR-17).
 *
 * Два действия, а не переключатель: подтвердить сделку или отклонить её правом
 * ВЕТО. Второе закрывает объект для площадки на пять месяцев, и об этом
 * сказано прямо на кнопке — цена решения не должна выясняться после клика.
 */
function Decision({ lotId, onChanged }: { lotId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (path: 'confirm' | 'veto'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/lots/${lotId}/${path}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        setError('Решение не принято — обновите страницу и попробуйте снова.');
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-8 border-t border-[var(--color-rule)] pt-6">
      <p className="eyebrow mb-4">Торги завершены — решение за вами</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('confirm')}
          className="deposit-action"
        >
          Подтвердить сделку
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('veto')}
          className="deposit-action deposit-action--ghost"
        >
          Право ВЕТО · карантин 5 месяцев
        </button>
      </div>
      {error !== null && <p className="mt-4 text-xs text-[var(--color-alert)]">{error}</p>}
    </div>
  );
}

function Metric({ term, value }: { term: string; value: number | string }) {
  return (
    <div>
      <dt className="eyebrow mb-2">{term}</dt>
      <dd className="tabular text-lg text-[var(--color-paper)]">{value}</dd>
    </div>
  );
}
