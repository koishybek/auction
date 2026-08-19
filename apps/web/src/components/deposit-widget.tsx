'use client';

import type { DepositView } from '@auction/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  awaitsBank,
  depositStage,
  formatRemaining,
  remainingAfter,
  type DepositTone,
} from '@/lib/deposit-view';
import { formatTenge } from '@/lib/format';

/**
 * Виджет задатка (T-036, FR-12).
 *
 * Десять процентов стартовой цены на спецсчёте — пропуск к ставкам. Виджет
 * показывает, где эти деньги сейчас, даёт два способа их внести и отсчитывает
 * SLA возврата.
 *
 * Опрос вместо подписки на сокет: оплату подтверждает банк отдельным вебхуком,
 * приходит он через секунды или минуты после нажатия кнопки, и держать ради
 * этого отдельный канал незачем. Опрос идёт, только пока ждём банк.
 *
 * Запрос уходит с cookie сессии (`credentials: 'include'`) и без токена в
 * JavaScript: токен, доступный скриптам, — это токен, доступный любому чужому
 * скрипту на странице. Пока входа инвестора в web нет (Phase 5), сервер
 * ответит 401, и виджет честно скажет об этом.
 */

const POLL_INTERVAL_MS = 4_000;
const TICK_INTERVAL_MS = 1_000;

type Snapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  /** Вошёл, но задаток по этому лоту вносить не может. Причина — от сервера. */
  | { readonly kind: 'forbidden'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly view: DepositView };

/**
 * Почему сервер отказал. Код приходит в теле ответа — тем же полем, что и у
 * отказов по ставке.
 *
 * Без этого разбора вошедший продавец, открывший собственный лот, читал
 * «Войдите, чтобы продолжить»: сообщение врало о причине, и человек шёл
 * входить второй раз.
 */
function forbiddenReason(code: unknown): string {
  if (code === 'SELLER_OWN_LOT') {
    return 'Это ваш лот. Продавец не участвует в торгах по собственному объекту.';
  }
  if (code === 'EGOV_NOT_VERIFIED') {
    return 'Нужна учётная запись, подтверждённая через eGov: задаток — это деньги.';
  }
  if (code === 'USER_BLOCKED') {
    return 'Учётная запись заблокирована. Обратитесь к оператору площадки.';
  }
  return 'Вносить задаток по этому лоту вам сейчас нельзя.';
}

export function DepositWidget({ lotId }: { lotId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (path: string, init?: RequestInit): Promise<void> => {
      try {
        const response = await fetch(`/api/lots/${lotId}/deposit${path}`, {
          ...init,
          credentials: 'include',
          cache: 'no-store',
          headers: { accept: 'application/json', ...init?.headers },
        });

        if (response.status === 401) {
          setSnapshot({ kind: 'anonymous' });
          return;
        }
        if (response.status === 403) {
          // 403 — это «вошёл, но нельзя», а не «войдите». Разные вещи, и
          // человеку важна именно причина.
          const body: unknown = await response.json().catch(() => null);
          const code =
            typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
          setSnapshot({ kind: 'forbidden', reason: forbiddenReason(code) });
          return;
        }
        if (!response.ok) {
          setSnapshot({ kind: 'error', message: `Сервер ответил ${String(response.status)}` });
          return;
        }

        const view = (await response.json()) as DepositView;
        setSnapshot({ kind: 'ready', view });
      } catch (error) {
        setSnapshot({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Сеть недоступна',
        });
      }
    },
    [lotId],
  );

  useEffect(() => {
    void call('');
  }, [call]);

  // Пока банк не ответил — переспрашиваем. Как только состояние устоялось,
  // опрос прекращается сам.
  const status = snapshot.kind === 'ready' ? snapshot.view.status : null;
  const polling = snapshot.kind === 'ready' && awaitsBank(status);
  useEffect(() => {
    if (!polling) {
      return;
    }
    const timer = setInterval(() => void call(''), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [polling, call]);

  const act = async (path: string, init?: RequestInit): Promise<void> => {
    setBusy(true);
    await call(path, { method: 'POST', ...init });
    setBusy(false);
  };

  return (
    <section aria-labelledby="deposit-title" className="mt-20">
      <h2 id="deposit-title" className="eyebrow mb-6">
        Задаток · 10 % стартовой цены
      </h2>

      {snapshot.kind === 'loading' && <Muted>Проверяем задаток…</Muted>}
      {snapshot.kind === 'anonymous' && (
        <Muted>Задаток вносит подтверждённый через eGov инвестор. Войдите, чтобы продолжить.</Muted>
      )}
      {snapshot.kind === 'forbidden' && <Muted>{snapshot.reason}</Muted>}
      {snapshot.kind === 'error' && <Muted>Не удалось получить статус: {snapshot.message}</Muted>}

      {snapshot.kind === 'ready' && (
        <DepositPanel
          view={snapshot.view}
          busy={busy}
          onInvoice={() => void act('/invoice')}
          onHold={() =>
            void act('/hold', {
              headers: { 'content-type': 'application/json' },
              // Токенизацию карты делает эквайринг; сюда попадает только токен.
              body: JSON.stringify({ cardToken: 'demo-card-token' }),
            })
          }
        />
      )}
    </section>
  );
}

function DepositPanel({
  view,
  busy,
  onInvoice,
  onHold,
}: {
  view: DepositView;
  busy: boolean;
  onInvoice: () => void;
  onHold: () => void;
}) {
  const stage = depositStage(view.status);
  const settled = view.status !== null && !awaitsBank(view.status) && view.status !== 'PENDING';

  return (
    <div className="grid gap-10 border-t border-[var(--color-rule)] pt-8 lg:grid-cols-[2fr_1fr]">
      <div>
        <div className="mb-4 flex items-baseline gap-4">
          <ToneDot tone={stage.tone} />
          <p className="text-lg text-[var(--color-paper)]">{stage.title}</p>
        </div>
        <p className="tabular text-3xl leading-none text-[var(--color-value)]">
          {formatTenge(view.requiredAmountTenge)}
        </p>
        <p className="mt-4 max-w-prose text-xs leading-relaxed text-[var(--color-muted)]">
          {stage.note}
        </p>

        {!settled && (
          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" onClick={onInvoice} disabled={busy} className="deposit-action">
              {view.payUrl === null ? 'Выставить счёт (IBAN)' : 'Обновить счёт'}
            </button>
            <button
              type="button"
              onClick={onHold}
              disabled={busy}
              className="deposit-action deposit-action--ghost"
            >
              Заморозить на карте
            </button>
          </div>
        )}

        {view.payUrl !== null && (
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            Счёт выставлен:{' '}
            <a href={view.payUrl} className="underline" rel="noreferrer noopener" target="_blank">
              перейти к оплате
            </a>
          </p>
        )}
      </div>

      <RefundCountdown view={view} />
    </div>
  );
}

/**
 * Таймер SLA возврата.
 *
 * Сервер присылает остаток, браузер вычитает из него прошедшее по
 * `performance.now()` — счётчику, который не прыгает от перевода часов. Своих
 * часов у клиента нет ни здесь, ни в торгах (CLAUDE.md §4.3).
 */
function RefundCountdown({ view }: { view: DepositView }) {
  const serverRemaining = view.refundRemainingMs;
  const receivedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (serverRemaining === null) {
      return;
    }
    receivedAt.current = performance.now();
    setElapsed(0);

    const timer = setInterval(() => {
      setElapsed(performance.now() - receivedAt.current);
    }, TICK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [serverRemaining]);

  if (serverRemaining === null) {
    return (
      <div className="border-t border-[var(--color-rule)] pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
        <h3 className="eyebrow mb-4">Возврат</h3>
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">
          Проигравшим задаток возвращается в течение 24 часов после завершения торгов. Отсчёт
          начнётся, когда торги закроются.
        </p>
      </div>
    );
  }

  const left = remainingAfter(serverRemaining, elapsed);
  return (
    <div className="border-t border-[var(--color-rule)] pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
      <h3 className="eyebrow mb-4">До возврата</h3>
      <p className="tabular text-2xl leading-none text-[var(--color-paper)]" aria-live="polite">
        {formatRemaining(left)}
      </p>
      <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
        {left === 0 ? 'Срок вышел — возврат на контроле.' : 'Срок по регламенту — 24 часа.'}
      </p>
    </div>
  );
}

const TONE_COLOR: Readonly<Record<DepositTone, string>> = {
  idle: 'var(--color-rule)',
  waiting: 'var(--color-muted)',
  ready: 'var(--color-value)',
  refund: 'var(--color-muted)',
  closed: 'var(--color-rule)',
};

function ToneDot({ tone }: { tone: DepositTone }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: TONE_COLOR[tone] }}
    />
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-prose border-t border-[var(--color-rule)] pt-8 text-xs leading-relaxed text-[var(--color-muted)]">
      {children}
    </p>
  );
}
