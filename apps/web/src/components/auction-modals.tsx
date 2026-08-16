'use client';

import { useCallback, useEffect, useState } from 'react';

import { formatTenge } from '@/lib/format';

/**
 * Модалки и баннер аукционного зала (T-040, FR-07/FR-08/FR-14).
 *
 * Все три появляются не по нажатию, а по событию с сервера: торги закрылись,
 * связь деградировала, участнику №2 предложен выбор. Ни одно из этих решений
 * клиент не принимает сам.
 */

/** Общая рамка модалки. Диалог, а не div: клавиатура и скринридер обязаны его находить. */
function Modal({
  title,
  children,
  labelledBy,
}: {
  title: string;
  labelledBy: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-ink-sunken)]/85 p-6"
    >
      <div className="w-full max-w-lg border border-[var(--color-rule-bright)] bg-[var(--color-ink-raised)] p-8">
        <h2 id={labelledBy} className="eyebrow mb-6">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/**
 * «ТОРГИ ЗАВЕРШЕНЫ. Победитель: Инвестор #NNN» (ТЗ §2.1, FR-07).
 *
 * Победитель назван псевдонимом — тем же, что был в ленте. Реальное имя не
 * появляется даже в момент закрытия: участники остаются анонимны друг для
 * друга и после торгов (FR-09).
 */
export function FinishModal({
  winnerBlindId,
  finalPriceTenge,
}: {
  winnerBlindId: string | null;
  finalPriceTenge: number;
}) {
  return (
    <Modal title="Торги завершены" labelledBy="finish-title">
      <p className="mb-6 text-lg text-[var(--color-paper)]">
        {winnerBlindId === null ? (
          'Ставок не было — покупателя не нашлось.'
        ) : (
          <>
            Победитель: <span className="tabular">{winnerBlindId}</span>
          </>
        )}
      </p>
      <dl className="border-t border-[var(--color-rule)] pt-6">
        <dt className="eyebrow mb-2">Итоговая цена</dt>
        <dd className="tabular text-3xl text-[var(--color-value)]">
          {formatTenge(finalPriceTenge)}
        </dd>
      </dl>
      <p className="mt-6 text-xs leading-relaxed text-[var(--color-muted)]">
        Протокол торгов формируется автоматически. Проигравшим задаток возвращается в течение 24
        часов.
      </p>
    </Modal>
  );
}

/**
 * Баннер сетевой паузы (ТЗ §2.2, FR-08).
 *
 * Не модалка: торги не закончились, и закрывать ими экран нельзя — участник
 * должен видеть цену и замерший таймер. Отсчёт до возобновления идёт от
 * серверного значения по монотонным часам браузера.
 */
export function FreezeBanner({ resumeInMs }: { resumeInMs: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = performance.now();
    const timer = setInterval(() => {
      setElapsed(performance.now() - startedAt);
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [resumeInMs]);

  const left = Math.max(0, Math.ceil((resumeInMs - elapsed) / 1000));

  return (
    <div
      role="status"
      className="mb-8 border border-[var(--color-value)] bg-[var(--color-ink-raised)] p-5"
    >
      <p className="text-sm text-[var(--color-value)]">
        Сетевая пауза (SLA Freeze). Таймер остановлен, ставки не принимаются.
      </p>
      <p className="tabular mt-2 text-xs text-[var(--color-muted)]">
        Возобновление через {String(left)} с
      </p>
    </div>
  );
}

interface RunnerUpState {
  readonly offered: boolean;
  readonly option: 'A' | 'B' | null;
  readonly remainingMs: number | null;
}

/**
 * Окно участника №2 (FR-14).
 *
 * Появляется только тому, кому сервер действительно предложил выбор. Спросить
 * об этом приходится отдельно: право на выбор — не часть публичного состояния
 * торгов, и в общую рассылку оно попасть не может.
 */
export function RunnerUpModal({ lotId }: { lotId: string }) {
  const [state, setState] = useState<RunnerUpState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/lots/${lotId}/deposit/runner-up`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    setState(response.ok ? ((await response.json()) as RunnerUpState) : null);
  }, [lotId]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (option: 'A' | 'B'): Promise<void> => {
    setBusy(true);
    await fetch(`/api/lots/${lotId}/deposit/runner-up`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ option }),
    });
    await load();
    setBusy(false);
  };

  if (state === null || !state.offered) {
    return null;
  }

  return (
    <Modal title="Вы второй участник" labelledBy="runner-up-title">
      <p className="mb-6 text-sm leading-relaxed text-[var(--color-paper)]">
        Победитель обязан доплатить 90 % в течение пяти банковских дней. Вы можете оставить задаток
        на это время и получить право выкупа, если он не рассчитается.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose('A')}
          className="deposit-action"
        >
          Оставить задаток на 5 дней
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose('B')}
          className="deposit-action deposit-action--ghost"
        >
          Вернуть задаток
        </button>
      </div>
      <p className="mt-6 text-xs leading-relaxed text-[var(--color-muted)]">
        Без ответа задаток возвращается автоматически: молчание возвращает деньги, а не удерживает
        их.
      </p>
    </Modal>
  );
}
