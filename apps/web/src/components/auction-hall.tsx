'use client';

import { useEffect } from 'react';

import {
  bidLabel,
  canBid,
  formatTimer,
  resolveWsUrl,
  timerZone,
  type FeedEntry,
  type TimerZone,
} from '@/lib/auction-hall';
import { formatTenge } from '@/lib/format';
import { useAuctionStore } from '@/store/auction-store';

/**
 * Аукционный зал (T-039, FR-13).
 *
 * Три вещи на экране и ничего больше: сколько осталось, сколько стоит, кто
 * поднял. Всё три приходят с сервера — ни одна не вычисляется здесь. Свой
 * обратный отсчёт разошёлся бы с сервером на дрейф часов и на заморозку
 * вкладки в фоне, а на пятидесяти секундах это решает исход торгов.
 */

const ZONE_COLOR: Readonly<Record<TimerZone, string>> = {
  calm: 'var(--color-signal)',
  warning: 'var(--color-value)',
  critical: 'var(--color-alert)',
};

/** Почему ставка не прошла — словами участника, а не кодами сервера. */
const REJECT_TEXT: Readonly<Record<string, string>> = {
  PRICE_MISMATCH: 'Цену успели поднять. Сумма на кнопке обновлена.',
  SELF_OUTBID: 'Вы и так лидируете — перебивать себя нельзя.',
  NO_DEPOSIT: 'Задаток не на спецсчёте. Внесите 10 % и возвращайтесь.',
  EGOV_NOT_VERIFIED: 'Нужна верификация через eGov.',
  SELLER_OWN_LOT: 'Продавец не участвует в торгах по своему лоту.',
  USER_BLOCKED: 'Доступ к торгам закрыт.',
  RATE_LIMITED: 'Слишком часто. Не больше одной ставки в полсекунды.',
  TIMER_EXPIRED: 'Торги закрылись раньше, чем дошла ставка.',
  NOT_RUNNING: 'По этому лоту торги не идут.',
  INVALID_TOKEN: 'Войдите, чтобы участвовать в торгах.',
};

export function AuctionHall({
  lotId,
  wsUrlOverride,
  wsPort,
}: {
  lotId: string;
  wsUrlOverride: string | undefined;
  wsPort: string;
}) {
  const hall = useAuctionStore((store) => store.hall);
  const connection = useAuctionStore((store) => store.connection);
  const feedback = useAuctionStore((store) => store.feedback);
  const join = useAuctionStore((store) => store.join);
  const leave = useAuctionStore((store) => store.leave);
  const placeBid = useAuctionStore((store) => store.placeBid);

  useEffect(() => {
    // Адрес собирается в браузере: имя хоста должно совпасть с тем, по
    // которому выдана кука сессии, иначе сокет придёт неопознанным.
    join(lotId, resolveWsUrl(wsUrlOverride, window.location, wsPort));
    return () => {
      leave();
    };
  }, [lotId, wsUrlOverride, wsPort, join, leave]);

  const zone = timerZone(hall.timeRemainingMs);
  // Право ставить решает сервер; здесь только состояние торгов и связь.
  const enabled = canBid(hall, { authenticated: connection === 'online' });

  return (
    <section aria-labelledby="hall-title" className="mt-20">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 id="hall-title" className="eyebrow">
          Торговый зал · Фаза III
        </h2>
        <ConnectionBadge state={connection} />
      </div>

      <div className="grid gap-10 border-t border-[var(--color-rule)] pt-10 lg:grid-cols-[1fr_1fr]">
        <div>
          <h3 className="eyebrow mb-4">До закрытия</h3>
          <p
            className="tabular text-6xl leading-none tracking-tight sm:text-7xl"
            style={{ color: ZONE_COLOR[zone] }}
            aria-live="off"
          >
            {formatTimer(hall.timeRemainingMs)}
          </p>
          <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
            {hall.status === 'FROZEN'
              ? 'Сетевая пауза (SLA Freeze). Таймер остановлен, ставки не принимаются.'
              : hall.status === 'FINISHED'
                ? 'Торги завершены.'
                : 'Любая принятая ставка возвращает отсчёт к пятидесяти секундам.'}
          </p>
        </div>

        <div>
          <h3 className="eyebrow mb-4">Текущая цена</h3>
          <p className="tabular text-5xl leading-none text-[var(--color-value)]">
            {formatTenge(hall.currentPriceTenge)}
          </p>

          {hall.status === 'FINISHED' ? (
            <p className="mt-8 border border-[var(--color-rule)] p-5 text-sm">
              Торги завершены. Победитель:{' '}
              <span className="text-[var(--color-paper)]">{hall.winnerBlindId ?? 'нет'}</span>
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={placeBid}
                disabled={!enabled}
                className="deposit-action mt-8 w-full py-4 text-sm"
              >
                {bidLabel(hall)}
              </button>
              <Feedback feedback={feedback} />
            </>
          )}
        </div>
      </div>

      <Feed entries={hall.feed} />
    </section>
  );
}

function Feedback({ feedback }: { feedback: { kind: string; code?: string } | null }) {
  if (feedback === null) {
    return null;
  }
  if (feedback.kind === 'accepted') {
    return (
      <p className="mt-4 text-xs text-[var(--color-signal)]" role="status">
        Ставка принята.
      </p>
    );
  }
  const code = feedback.code ?? 'UNKNOWN';
  return (
    <p className="mt-4 text-xs text-[var(--color-alert)]" role="status">
      {REJECT_TEXT[code] ?? `Ставка не прошла (${code}).`}
    </p>
  );
}

/**
 * Лента ставок.
 *
 * Реальных имён здесь нет и не будет: участник виден псевдонимом, который
 * меняется от лота к лоту (FR-09).
 */
function Feed({ entries }: { entries: readonly FeedEntry[] }) {
  return (
    <div className="mt-16">
      <h3 className="eyebrow mb-5">Лента ставок</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">Ставок пока нет.</p>
      ) : (
        <ol className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
          {entries.map((entry) => (
            <li key={entry.seq} className="flex items-baseline justify-between py-3 text-sm">
              <span className="tabular text-xs text-[var(--color-muted)]">
                №{String(entry.seq).padStart(3, '0')}
              </span>
              <span className="text-[var(--color-paper)]">{entry.blindId}</span>
              <span className="tabular text-[var(--color-value)]">
                {formatTenge(entry.priceTenge)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ConnectionBadge({ state }: { state: 'offline' | 'connecting' | 'online' }) {
  const text =
    state === 'online' ? 'связь есть' : state === 'connecting' ? 'подключаемся' : 'нет связи';
  const color = state === 'online' ? 'var(--color-signal)' : 'var(--color-muted)';
  return (
    <span className="eyebrow flex items-center gap-2" style={{ color }}>
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
      />
      {text}
    </span>
  );
}
