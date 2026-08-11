import type { LotView } from '@auction/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PhaseRatchet } from '@/components/phase-ratchet';
import { getLots } from '@/lib/api-client';
import { formatTenge, lotTypeLabel } from '@/lib/format';

// Каталог отражает живые торги: кэшировать его значит показывать вчерашние цены.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Лоты на торгах',
  description:
    'Список объектов на открытых торгах: недвижимость и транспорт. Фаза лота, стартовая и текущая цена, шаг ставки +3 %.',
  alternates: { canonical: '/' },
};

export default async function CatalogPage() {
  const result = await getLots({ pageSize: 50 });

  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <section aria-labelledby="catalog-title" className="mb-14">
        <p className="eyebrow mb-4">Открытые торги · Казахстан</p>
        <h1 id="catalog-title" className="font-serif text-4xl leading-[1.1] sm:text-5xl">
          Цена идёт только вверх.
          <br />
          <span className="text-[var(--color-muted)]">Шагами по три процента.</span>
        </h1>
        <p className="mt-6 max-w-xl text-sm leading-relaxed text-[var(--color-muted)]">
          Каждая принятая ставка поднимает цену на 3 % и возвращает таймер к пятидесяти секундам.
          Пятьдесят секунд тишины — и лот уходит. Участники видят друг друга только по номерам.
        </p>
      </section>

      {!result.ok ? (
        <ErrorState message={result.error} />
      ) : result.data.items.length === 0 ? (
        <EmptyState />
      ) : (
        <LotBoard lots={result.data.items} total={result.data.total} />
      )}
    </main>
  );
}

function LotBoard({ lots, total }: { lots: readonly LotView[]; total: number }) {
  return (
    <section aria-labelledby="board-title">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="board-title" className="eyebrow">
          Лоты в торгах
        </h2>
        <span className="tabular text-xs text-[var(--color-muted)]">{total}</span>
      </div>

      {/* Доска, а не сетка карточек: цена — это столбец, её сравнивают взглядом. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-left">
          <thead>
            <tr className="border-y border-[var(--color-rule)]">
              <th scope="col" className="eyebrow py-3 pr-4 font-normal">
                Фаза
              </th>
              <th scope="col" className="eyebrow py-3 pr-4 font-normal">
                Объект
              </th>
              <th scope="col" className="eyebrow py-3 pr-4 font-normal">
                Тип
              </th>
              <th scope="col" className="eyebrow py-3 pl-4 text-right font-normal">
                Цена
              </th>
            </tr>
          </thead>
          <tbody>
            {lots.map((lot) => (
              <LotRow key={lot.id} lot={lot} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LotRow({ lot }: { lot: LotView }) {
  const price = lot.currentPriceTenge ?? lot.startPriceTenge;
  const isLive = lot.status === 'PHASE_III';

  return (
    <tr className="border-b border-[var(--color-rule)] transition-colors hover:bg-[var(--color-ink-raised)]">
      <td className="py-4 pr-4 align-middle">
        <PhaseRatchet status={lot.status} />
      </td>
      <td className="py-4 pr-4 align-middle">
        {/*
          Ссылка — на самом номере объекта, без растягивания на всю строку:
          в таблице такой приём ломает выделение текста и порядок обхода
          с клавиатуры. Цель увеличена padding'ом, строка подсвечивается.
        */}
        <Link
          href={`/lots/${lot.id}`}
          className="tabular -my-2 inline-block py-2 text-sm hover:text-[var(--color-signal)]"
        >
          {lot.cadastreOrVin}
          <span className="sr-only"> — открыть карточку лота</span>
        </Link>
        {isLive && <span className="ml-3 text-xs text-[var(--color-signal)]">торги идут</span>}
      </td>
      <td className="py-4 pr-4 align-middle text-sm text-[var(--color-muted)]">
        {lotTypeLabel(lot.type)}
      </td>
      <td className="tabular py-4 pl-4 text-right align-middle text-sm text-[var(--color-value)]">
        {formatTenge(price)}
      </td>
    </tr>
  );
}

function EmptyState() {
  return (
    <div className="border-y border-[var(--color-rule)] py-20 text-center">
      <p className="font-serif text-2xl">Сейчас торгов нет</p>
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        Лоты появляются здесь, когда проходят проверку реестров и выходят в Фазу I.
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="border-y border-[var(--color-alert)]/40 py-20 text-center">
      <p className="font-serif text-2xl">Список лотов недоступен</p>
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        Торговый сервер не ответил. Обновите страницу через минуту.
      </p>
      <p className="tabular mt-4 text-xs text-[var(--color-muted)]">{message}</p>
    </div>
  );
}
