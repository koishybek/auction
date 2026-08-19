import type { LotView } from '@auction/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AuctionHall } from '@/components/auction-hall';
import { AuctionResult } from '@/components/auction-result';
import { RunnerUpModal } from '@/components/auction-modals';
import { DepositWidget } from '@/components/deposit-widget';
import { PhaseRatchet, phaseLabel } from '@/components/phase-ratchet';
import { ViewBeacon } from '@/components/view-beacon';
import { getLot } from '@/lib/api-client';
import { formatTenge, identifierLabel, lotTypeLabel, nextBidTenge } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  // В Next 15+ параметры маршрута приходят промисом.
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await getLot(id);
  if (!result.ok) {
    return { title: 'Лот не найден', robots: { index: false, follow: false } };
  }

  const lot = result.data;
  const price = lot.currentPriceTenge ?? lot.startPriceTenge;
  const title = `${lotTypeLabel(lot.type)} ${lot.cadastreOrVin}`;

  return {
    title,
    description: `${title} на открытых торгах. ${phaseLabel(lot.status)}. Текущая цена ${formatTenge(price)}, шаг ставки +3 %.`,
    alternates: { canonical: `/lots/${lot.id}` },
    openGraph: {
      title,
      description: `${phaseLabel(lot.status)} · ${formatTenge(price)}`,
      type: 'article',
    },
  };
}

export default async function LotPage({ params }: PageProps) {
  const { id } = await params;
  const result = await getLot(id);
  if (!result.ok) {
    notFound();
  }

  const lot = result.data;
  const price = lot.currentPriceTenge ?? lot.startPriceTenge;

  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <ViewBeacon lotId={lot.id} />

      <nav aria-label="Навигация" className="mb-10">
        <Link href="/" className="eyebrow transition-colors hover:text-[var(--color-paper)]">
          ← Все лоты
        </Link>
      </nav>

      <header className="mb-16 border-b border-[var(--color-rule)] pb-10">
        <div className="mb-5 flex items-center gap-4">
          <PhaseRatchet status={lot.status} size="lg" />
          <span className="eyebrow">{phaseLabel(lot.status)}</span>
        </div>

        <h1 className="font-serif text-4xl leading-tight sm:text-5xl">{lotTypeLabel(lot.type)}</h1>
        <p className="tabular mt-4 text-sm text-[var(--color-muted)]">
          {identifierLabel(lot.type)} · {lot.cadastreOrVin}
        </p>
      </header>

      <PriceLadder lot={lot} price={price} />

      {/* Зал живёт сокетом и таймером — то и другое имеет смысл только в торгах. */}
      {lot.status === 'PHASE_III' && (
        <AuctionHall
          lotId={lot.id}
          wsUrlOverride={process.env['NEXT_PUBLIC_WS_URL']}
          wsPort={process.env['NEXT_PUBLIC_WS_PORT'] ?? '3200'}
        />
      )}

      {/*
       * У закрытых торгов зала уже нет, а итог есть — и его обязан видеть
       * каждый, кто откроет ссылку потом: из каталога, из письма, просто
       * обновив вкладку. Победителя показывает сервер, из PostgreSQL.
       */}
      {lot.status === 'FINISHED' && (
        <>
          <AuctionResult lotId={lot.id} />
          {/*
           * Выбор участника №2 живёт пять дней (FR-14) — то есть заведомо
           * дольше, чем открыта вкладка. Раньше окно монтировалось только
           * внутри зала, а зал у закрытого лота не монтируется вовсе: человек,
           * перезагрузивший страницу, терял своё право совсем. Переспрос здесь
           * не нужен — метка давно записана, хватает одного вопроса.
           */}
          <RunnerUpModal lotId={lot.id} />
        </>
      )}

      {/*
       * Задаток вносится на Фазе II (допуск участников) и остаётся виден в
       * торгах: участнику важно понимать, почему кнопка ставки не работает.
       */}
      {(lot.status === 'PHASE_II' || lot.status === 'PHASE_III') && (
        <DepositWidget lotId={lot.id} />
      )}

      <section aria-labelledby="rules-title" className="mt-20">
        <h2 id="rules-title" className="eyebrow mb-6">
          Как проходят торги
        </h2>
        <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          <Rule term="Шаг ставки" value="+3 %">
            Других шагов нет. Сумму назначает сервер, а не участник.
          </Rule>
          <Rule term="Таймер" value="50 секунд">
            Каждая принятая ставка возвращает отсчёт к пятидесяти секундам.
          </Rule>
          <Rule term="Задаток" value="10 %">
            Без задатка на спецсчёте ставка не принимается. Проигравшим возврат за 24 часа.
          </Rule>
          <Rule term="Участники" value="Анонимны">
            В ленте видны только номера вида «Инвестор #704». Номер меняется от лота к лоту.
          </Rule>
        </dl>
      </section>
    </main>
  );
}

/**
 * Геройский элемент страницы: цена и следующий шаг рядом.
 *
 * Механика +3 % показана до начала торгов — участник заранее видит, во что
 * обойдётся один клик. Это и есть самое характерное в продукте.
 */
function PriceLadder({ lot, price }: { lot: LotView; price: number }) {
  const next = nextBidTenge(price);
  const isLive = lot.status === 'PHASE_III';
  const isFinished = lot.status === 'FINISHED';

  return (
    <section aria-labelledby="price-title" className="grid gap-10 lg:grid-cols-[2fr_1fr]">
      <div>
        <h2 id="price-title" className="eyebrow mb-4">
          {isFinished
            ? 'Итоговая цена'
            : lot.currentPriceTenge === null
              ? 'Стартовая цена'
              : 'Текущая цена'}
        </h2>
        <p className="tabular text-5xl leading-none text-[var(--color-value)] sm:text-6xl">
          {formatTenge(price)}
        </p>
      </div>

      {!isFinished && (
        <div className="border-l-0 border-t border-[var(--color-rule)] pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
          <h2 className="eyebrow mb-4">Следующий шаг · +3 %</h2>
          <p className="tabular text-2xl leading-none text-[var(--color-muted)]">
            {formatTenge(next)}
          </p>
          <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
            {isLive
              ? 'Ставка поднимет цену до этой суммы и вернёт таймер к пятидесяти секундам.'
              : 'С этой суммы начнётся первый шаг, когда лот выйдет в Фазу III.'}
          </p>
        </div>
      )}
    </section>
  );
}

function Rule({
  term,
  value,
  children,
}: {
  term: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="eyebrow mb-2">{term}</dt>
      <dd>
        <p className="tabular mb-2 text-lg text-[var(--color-paper)]">{value}</p>
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">{children}</p>
      </dd>
    </div>
  );
}
