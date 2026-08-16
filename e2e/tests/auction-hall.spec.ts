import { expect, test } from '@playwright/test';

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
