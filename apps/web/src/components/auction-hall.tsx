'use client';

import { useEffect, useRef, useState } from 'react';

import { BehaviorTracker } from '@/lib/behavior-tracker';

import { FinishModal, FreezeBanner, RunnerUpModal } from '@/components/auction-modals';
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
  CAPTCHA_REQUIRED: 'Подтвердите, что вы человек, — и ставьте дальше.',
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
  const hasBid = useAuctionStore((store) => store.hasBid);
  const resumeInMs = useAuctionStore((store) => store.resumeInMs);
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

  // Право ставить решает сервер — спрашиваем его, а не догадываемся. Спрятанная
  // кнопка ничего не разрешает и ничего не запрещает: отказ всё равно приходит
  // с сервера, но предлагать то, что будет отклонено, незачем (FR-16).
  /**
   * Сборщик поведения живёт весь срок жизни зала (FR-11).
   *
   * Движения указателя копятся до клика — после него сервер уже ничего
   * спросить не может.
   */
  const behavior = useRef(new BehaviorTracker());
  const [deny, setDeny] = useState<string | null>(null);
  useEffect(() => {
    void fetch(`/api/lots/${lotId}/auction/eligibility`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          setDeny('INVALID_TOKEN');
          return;
        }
        const body = (await response.json()) as { allowed: boolean; code: string | null };
        setDeny(body.allowed ? null : (body.code ?? 'UNKNOWN'));
      })
      .catch(() => setDeny('UNKNOWN'));
  }, [lotId]);

  const zone = timerZone(hall.timeRemainingMs);
  const enabled = deny === null && canBid(hall, { authenticated: connection === 'online' });

  return (
    <section aria-labelledby="hall-title" className="mt-20">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 id="hall-title" className="eyebrow">
          Торговый зал · Фаза III
        </h2>
        <ConnectionBadge state={connection} />
      </div>

      {/* Пауза — баннер, а не модалка: торги не закончились, и закрывать
          экран нельзя — участник должен видеть цену и замерший таймер. */}
      {hall.status === 'FROZEN' && resumeInMs !== null && <FreezeBanner resumeInMs={resumeInMs} />}

      {hall.status === 'FINISHED' && (
        <>
          <FinishModal
            winnerBlindId={hall.winnerBlindId}
            finalPriceTenge={hall.currentPriceTenge}
          />
          {/* Выбор предложен ровно одному человеку — окно само решит, ему ли.
              `awaited` включает переспрос: метку участника №2 сервер пишет уже
              после события о закрытии, и тому, кто ставил, ответ может ещё
              ехать. Зрителю ждать нечего. */}
          <RunnerUpModal lotId={lotId} awaited={hasBid} />
        </>
      )}

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
                onPointerMove={(event) =>
                  behavior.current.track({
                    pointerType: event.pointerType,
                    clientX: event.clientX,
                    clientY: event.clientY,
                  })
                }
                onPointerEnter={() => behavior.current.enter()}
                onPointerLeave={() => behavior.current.leave()}
                onKeyDown={(event) => {
                  // Клавиатурная активация помечается явно: человек без мыши
                  // участвует наравне со всеми (FR-11).
                  if (event.key === 'Enter' || event.key === ' ') {
                    behavior.current.keyboard();
                  }
                }}
                onClick={(event) => {
                  // isTrusted различает живой клик и dispatchEvent из консоли.
                  placeBid(behavior.current.snapshot(event.nativeEvent.isTrusted));
                  behavior.current.reset();
                }}
                disabled={!enabled}
                className="deposit-action mt-8 w-full py-4 text-sm"
              >
                {bidLabel(hall)}
              </button>
              {deny !== null && (
                <p className="mt-4 text-xs text-[var(--color-muted)]" role="status">
                  {REJECT_TEXT[deny] ?? 'Ставки по этому лоту вам недоступны.'}
                </p>
              )}
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
