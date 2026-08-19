import { formatTenge } from '@/lib/format';
import { getLotBids } from '@/lib/api-client';

/**
 * Итог завершённых торгов (FR-06, FR-14).
 *
 * Отдельный раздел, а не аукционный зал: зал живёт сокетом и таймером, а у
 * закрытого лота ни того, ни другого больше нет. Зато есть то, ради чего всё
 * затевалось, — цена, по которой лот ушёл, и кто его взял.
 *
 * Раньше страница закрытого лота не показывала ничего из этого: зал
 * монтировался только на Фазе III, и человек, открывший ссылку после финиша —
 * из каталога, из письма, просто обновив вкладку, — видел карточку с итоговой
 * ценой и общими правилами. Победителя не видел никто, включая самого
 * победителя.
 *
 * Данные берутся из PostgreSQL, а не из состояния торгов в Redis: у состояния
 * есть срок жизни, а у результата торгов срока нет.
 */
export async function AuctionResult({ lotId }: { lotId: string }) {
  const result = await getLotBids(lotId, 10);
  const bids = result.ok ? result.data : [];
  const winning = bids[0] ?? null;

  return (
    <section aria-labelledby="result-title" className="mt-20">
      <h2 id="result-title" className="eyebrow mb-6">
        Итог торгов
      </h2>

      {winning === null ? (
        <p className="text-sm leading-relaxed text-[var(--color-muted)]">
          Ставок не было — покупатель не нашёлся. Лот может вернуться на торги по решению продавца.
        </p>
      ) : (
        <>
          <dl className="mb-10 grid gap-x-10 gap-y-8 sm:grid-cols-3">
            <div>
              <dt className="eyebrow mb-2">Победитель</dt>
              <dd className="tabular text-lg">{winning.last_bidder_blind_id}</dd>
            </div>
            <div>
              <dt className="eyebrow mb-2">Итоговая цена</dt>
              <dd className="tabular text-lg">{formatTenge(winning.current_price_kzt)}</dd>
            </div>
            <div>
              <dt className="eyebrow mb-2">Ставок в торгах</dt>
              <dd className="tabular text-lg">{winning.seq}</dd>
            </div>
          </dl>

          <h3 className="eyebrow mb-4">Последние ставки</h3>
          <ol className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
            {bids.map((bid) => (
              <li key={bid.seq} className="flex items-baseline justify-between gap-6 py-3">
                <span className="tabular text-sm text-[var(--color-muted)]">
                  #{bid.seq} · {bid.last_bidder_blind_id}
                </span>
                <span className="tabular text-sm">{formatTenge(bid.current_price_kzt)}</span>
              </li>
            ))}
          </ol>

          <p className="mt-6 text-xs leading-relaxed text-[var(--color-muted)]">
            Участники видны псевдонимами и после закрытия: номер выдаётся на один лот и в другом
            лоте у того же человека будет другим.
          </p>
        </>
      )}
    </section>
  );
}
