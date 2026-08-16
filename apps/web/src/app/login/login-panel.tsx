'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Панель входа. Все запросы — относительные и с куками; токен в JavaScript не
 * попадает ни на одном шаге.
 */

interface Me {
  readonly id: string;
  readonly roles: readonly string[];
  readonly egovVerified: boolean;
}

async function post(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  // Выход отвечает 204 без тела — разбирать нечего.
  return response.status === 204 ? null : response.json();
}

/** Случайный ИИН нужной длины: мок обязан гонять данные того же вида, что боевой eGov. */
function randomIin(): string {
  let digits = '';
  for (let index = 0; index < 12; index += 1) {
    digits += String(Math.floor(Math.random() * 10));
  }
  return digits;
}

export function LoginPanel() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
    setMe(response.ok ? ((await response.json()) as Me) : null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  };

  /** Полный путь eGov: QR → подтверждение гражданином → обмен на сессию. */
  const egovLogin = async (): Promise<void> => {
    const init = (await post('/api/auth/egov/init')) as { sessionId: string };
    await post('/api/auth/egov/dev-approve', {
      sessionId: init.sessionId,
      iin: randomIin(),
      fio: 'Тестовый Инвестор Тестович',
      biometricConfirmed: true,
    });
    await post('/api/auth/egov/complete', { sessionId: init.sessionId });
  };

  return (
    <div className="border-t border-[var(--color-rule)] pt-10">
      {me === null ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(egovLogin)}
            className="deposit-action"
          >
            Войти как инвестор (eGov)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => void (await post('/api/auth/dev-login', { roles: ['SELLER'] })))
            }
            className="deposit-action deposit-action--ghost"
          >
            Войти как продавец
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => void (await post('/api/auth/dev-login', { roles: ['ADMIN'] })))
            }
            className="deposit-action deposit-action--ghost"
          >
            Войти как админ
          </button>
        </div>
      ) : (
        <div>
          <dl className="mb-8 grid gap-4 sm:grid-cols-3">
            <Row term="Роли" value={me.roles.join(', ')} />
            <Row term="Верификация" value={me.egovVerified ? 'подтверждена' : 'нет'} />
            <Row term="Идентификатор" value={me.id.slice(0, 8)} />
          </dl>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => void (await post('/api/auth/logout')))}
            className="deposit-action deposit-action--ghost"
          >
            Выйти
          </button>
        </div>
      )}

      {error !== null && <p className="mt-6 text-xs text-[var(--color-alert)]">{error}</p>}
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow mb-2">{term}</dt>
      <dd className="tabular text-sm text-[var(--color-paper)]">{value}</dd>
    </div>
  );
}
