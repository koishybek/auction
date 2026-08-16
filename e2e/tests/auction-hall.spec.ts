import { expect, test } from '@playwright/test';

import { API_URL, GATEWAY_PORT } from '../stack';

import { investorPage, lotInAuction } from './arena';

/**
 * Аукционный зал в настоящем браузере (T-039, FR-13).
 *
 * DoD плана: цена на кнопке меняется не позже чем через тик после чужой
 * ставки. Юнит-тест чистой функции этого не докажет — между событием и
 * кнопкой стоят сокет, стор и рендер, и сломаться может любой из них.
 */

/**
 * Сумма из подписи кнопки «Сделать ставку +3 % · 46 350 000 ₸».
 *
 * Берётся часть после разделителя, иначе тройка из «+3 %» приклеивается к
 * цене. Разряды у браузера разделены неразрывным пробелом, поэтому цифры
 * вынимаются, а не сравниваются строкой.
 */
function priceOf(text: string): number {
  return Number((text.split('·').pop() ?? '').replace(/\D/gu, ''));
}

test.describe('T-039: аукционный зал', () => {
  test('DoD: чужая ставка меняет сумму на кнопке в пределах тика', async ({ browser, request }) => {
    const { lotId } = await lotInAuction(request);
    const first = await investorPage(browser, request, lotId);
    const second = await investorPage(browser, request, lotId);

    try {
      await first.page.goto(`/lots/${lotId}`);
      await second.page.goto(`/lots/${lotId}`);

      const button = first.page.getByRole('button', { name: /Сделать ставку/ });
      const otherButton = second.page.getByRole('button', { name: /Сделать ставку/ });

      // Кнопка появляется только когда пришёл снимок: до него сумма неизвестна.
      await expect(button).toBeEnabled();
      await expect(otherButton).toBeEnabled();

      const before = (await button.textContent()) ?? '';
      // Разделитель разрядов в браузере — неразрывный пробел, а не обычный:
      // сравнивать строки с пробелом здесь значит ловить призрак.
      expect(priceOf(before)).toBe(46_350_000);

      // Ставит второй участник — первый о ней узнаёт только по сокету.
      const startedAt = Date.now();
      await otherButton.click();

      // Тик таймера идёт раз в секунду; DoD допускает не больше одного тика.
      await expect(button).not.toHaveText(before, { timeout: 1_200 });
      const elapsed = Date.now() - startedAt;
      expect(elapsed, 'обновление кнопки должно укладываться в один тик').toBeLessThan(1_500);

      // Новая сумма — следующий шаг от новой цены, а не старое значение.
      expect(priceOf((await button.textContent()) ?? '')).toBe(47_740_500);
    } finally {
      await first.page.context().close();
      await second.page.context().close();
    }
  });

  test('лента показывает псевдонимы, а не людей', async ({ browser, request }) => {
    const { lotId } = await lotInAuction(request);
    const investor = await investorPage(browser, request, lotId);

    try {
      await investor.page.goto(`/lots/${lotId}`);
      const button = investor.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(button).toBeEnabled();
      await button.click();

      const feed = investor.page.getByRole('list').last();
      await expect(feed).toContainText(/Инвестор #\d{3,5}/);

      // Реального идентификатора участника в ленте нет и быть не может (FR-09).
      await expect(investor.page.locator('body')).not.toContainText(investor.userId);
    } finally {
      await investor.page.context().close();
    }
  });

  test('таймер идёт вниз и живёт на серверных значениях', async ({ browser, request }) => {
    const { lotId } = await lotInAuction(request);
    const investor = await investorPage(browser, request, lotId);

    try {
      await investor.page.goto(`/lots/${lotId}`);
      const timer = investor.page.getByText(/^\d{2}\.\d{3}$/);
      await expect(timer).toBeVisible();

      // Первый отсчёт появляется со снимком: до него на табло нули, и
      // сравнивать «было — стало» бессмысленно.
      await expect(timer).not.toHaveText('00.000', { timeout: 15_000 });

      const firstText = (await timer.textContent()) ?? '0';
      const first = Number(firstText.split('.')[0]);
      await investor.page.waitForTimeout(2_500);
      const secondText = (await timer.textContent()) ?? '0';
      const second = Number(secondText.split('.')[0]);

      expect(second, `таймер: ${firstText} → ${secondText}`).toBeLessThan(first);
      // Пятьдесят секунд — это потолок: больше сервер не пришлёт.
      expect(first).toBeLessThanOrEqual(50);
    } finally {
      await investor.page.context().close();
    }
  });

  /**
   * Ресинк после возвращения (T-030, QA-03).
   *
   * Возвращение делается перезагрузкой вкладки, а не `setOffline`: режим
   * «офлайн» в Chromium блокирует новые запросы, но уже открытый сокет
   * продолжает получать кадры — обрыв им не изобразить, а тест, который
   * «проверяет» несуществующий обрыв, хуже отсутствующего. Сам обрыв на
   * десять секунд проверяется серверным e2e; здесь важно другое — что
   * вернувшийся участник видит состояние на СЕЙЧАС, а не то, что было.
   */
  test('T-030: вернувшийся клиент видит состояние на сейчас', async ({ browser, request }) => {
    const { lotId } = await lotInAuction(request);
    const watcher = await investorPage(browser, request, lotId);
    const bidder = await investorPage(browser, request, lotId);

    try {
      await watcher.page.goto(`/lots/${lotId}`);
      await bidder.page.goto(`/lots/${lotId}`);
      await expect(watcher.page.getByRole('button', { name: /Сделать ставку/ })).toBeEnabled();

      // Пока наблюдатель «отсутствует», цена уходит вперёд двумя ставками.
      const bidButton = bidder.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(bidButton).toBeEnabled();
      await bidButton.click();
      await expect(bidder.page.getByText('Ставка принята.')).toBeVisible();

      // Хвост ленты в снимке приходит из PostgreSQL, а ставки доезжают туда
      // отдельным процессом. Ждём именно этого, а не «немного»: иначе тест
      // проверял бы скорость воркера, а не ресинк.
      await expect
        .poll(
          async () => {
            const feed = await request.get(`${API_URL}/api/lots/${lotId}/auction/bids`);
            return ((await feed.json()) as unknown[]).length;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);

      await watcher.page.reload();
      const watcherButton = watcher.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(watcherButton).toBeEnabled();

      // Снимок затирает представление целиком: догонять по кусочкам нечего.
      expect(priceOf((await watcherButton.textContent()) ?? '')).toBe(47_740_500);
      // Хвост ленты приезжает тем же снимком — иначе вернувшийся видел бы
      // пустую историю и не понимал, что происходило без него.
      await expect(watcher.page.getByRole('list').last()).toContainText(/Инвестор #\d{3,5}/);
    } finally {
      await watcher.page.context().close();
      await bidder.page.context().close();
    }
  });

  /**
   * QA-04, приёмочный сценарий ТЗ §6 (T-048).
   *
   * Ровно то, что делает злоумышленник: открывает DevTools и шлёт в сокет
   * свою сумму вместо той, что на кнопке. Проверять это моком сервиса
   * бессмысленно — весь смысл в том, что подмена идёт мимо интерфейса.
   */
  test('QA-04: подмена суммы через DevTools отклоняется сервером', async ({ browser, request }) => {
    const { lotId } = await lotInAuction(request);
    const investor = await investorPage(browser, request, lotId);

    try {
      await investor.page.goto(`/lots/${lotId}`);
      await expect(investor.page.getByRole('button', { name: /Сделать ставку/ })).toBeEnabled();

      const verdict = await investor.page.evaluate(
        async ({ lot, port }) =>
          new Promise<Record<string, unknown>>((done, fail) => {
            const socket = new WebSocket(`ws://${window.location.hostname}:${String(port)}`);
            socket.onopen = () => {
              socket.send(JSON.stringify({ event: 'join_lot', lot_id: lot }));
            };
            socket.onmessage = (message: MessageEvent<string>) => {
              const payload = JSON.parse(message.data) as Record<string, unknown>;
              if (payload['event'] === 'state_snapshot') {
                // Цена «поменьше» — классическая правка в консоли.
                socket.send(
                  JSON.stringify({
                    event: 'place_bid',
                    lot_id: lot,
                    amount_kzt: Number(payload['current_price_kzt']) + 1,
                  }),
                );
              }
              if (payload['event'] === 'bid_rejected' || payload['event'] === 'error') {
                socket.close();
                done(payload);
              }
              if (payload['event'] === 'bid_accepted') {
                socket.close();
                fail(new Error('подменённая сумма принята — это дыра в деньгах'));
              }
            };
            setTimeout(() => fail(new Error('сервер не ответил на подменённую ставку')), 15_000);
          }),
        { lot: lotId, port: GATEWAY_PORT },
      );

      // След попытки в audit_log проверяется серверным e2e (bid-audit):
      // ручки для чтения журнала наружу нет и быть не должно — журнал
      // читают из базы, а не по HTTP.
      expect(verdict['code']).toBe('PRICE_MISMATCH');
    } finally {
      await investor.page.context().close();
    }
  });

  test('гость видит торги, но кнопка ему недоступна', async ({ browser, request }) => {
    const { lotId } = await lotInAuction(request);
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`/lots/${lotId}`);
      // Ход торгов публичен — смотреть может кто угодно.
      await expect(page.getByText('Торговый зал')).toBeVisible();
      await expect(page.getByText(/^\d{2}\.\d{3}$/)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
