import { expect, test } from '@playwright/test';

import { GATEWAY_PORT } from '../stack';

import { investorPage, lotInAuction, sellerPage } from './arena';

/**
 * Кабинет продавца (T-041, FR-15/FR-16).
 *
 * DoD плана: у роли продавца `place_bid` отклоняется НА СЕРВЕРЕ, а не только
 * прячется кнопка. Поэтому тест не ограничивается интерфейсом: он открывает
 * сокет прямо из страницы продавца и пробует поставить.
 */

test.describe('T-041: кабинет продавца', () => {
  test('монитор прозрачности показывает интерес к лоту', async ({ browser, request }) => {
    const { lotId, seller } = await lotInAuction(request);
    const investor = await investorPage(browser, request, lotId);
    const page = await sellerPage(browser, seller);

    try {
      // Просмотр карточки участником — та самая цифра, ради которой монитор.
      await investor.page.goto(`/lots/${lotId}`);
      await expect(investor.page.getByText('Торговый зал')).toBeVisible();
      await investor.page.getByRole('button', { name: /Сделать ставку/ }).click();
      await expect(investor.page.getByText('Ставка принята.')).toBeVisible();

      await page.goto('/seller');
      const row = page.getByRole('listitem').filter({ hasText: 'Недвижимость' });
      await expect(row).toBeVisible();

      // Просмотры считаются вместе с ещё не сброшенными в базу.
      await expect(row.getByText('Просмотры').locator('..')).toContainText(/[1-9]/);
      await expect(row.getByText('Ставки').locator('..')).toContainText('1');
      // Во время торгов кабинет прямо говорит, что он только на просмотр.
      await expect(row).toContainText('только просмотр');
    } finally {
      await investor.page.context().close();
      await page.context().close();
    }
  });

  test('DoD: ставка продавца по своему лоту отклоняется сервером', async ({ browser, request }) => {
    const { lotId, seller } = await lotInAuction(request);
    const page = await sellerPage(browser, seller);

    try {
      await page.goto(`/lots/${lotId}`);
      await expect(page.getByText('Торговый зал')).toBeVisible();

      // Кнопка недоступна и сказано почему — но это только вежливость.
      const button = page.getByRole('button', { name: /Сделать ставку/ });
      await expect(button).toBeDisabled();
      await expect(page.getByText('Продавец не участвует в торгах по своему лоту.')).toBeVisible();

      // А теперь то, что требует DoD: ставка в обход интерфейса, прямо в
      // сокет, из сессии продавца. Спрятанная кнопка ничего не защищает.
      const verdict = await page.evaluate(
        async ({ lot, port }) =>
          new Promise<Record<string, unknown>>((done, fail) => {
            const socket = new WebSocket(`ws://${window.location.hostname}:${String(port)}`);
            socket.onopen = () => {
              socket.send(JSON.stringify({ event: 'join_lot', lot_id: lot }));
            };
            socket.onmessage = (message: MessageEvent<string>) => {
              const payload = JSON.parse(message.data) as Record<string, unknown>;
              if (payload['event'] === 'state_snapshot') {
                // Сигналы клика обычные: проверяется запрет продавцу, а не
                // антибот — иначе первым сработал бы он (T-049).
                socket.send(
                  JSON.stringify({
                    event: 'place_bid',
                    lot_id: lot,
                    amount_kzt: payload['next_price_kzt'],
                    behavior: {
                      trusted: true,
                      kind: 'mouse',
                      moves: 18,
                      path_px: 240,
                      dwell_ms: 160,
                    },
                  }),
                );
              }
              if (payload['event'] === 'bid_rejected' || payload['event'] === 'error') {
                socket.close();
                done(payload);
              }
              if (payload['event'] === 'bid_accepted') {
                socket.close();
                fail(new Error('ставка продавца принята — это подлог, а не участие'));
              }
            };
            setTimeout(() => fail(new Error('сервер не ответил на ставку')), 15_000);
          }),
        { lot: lotId, port: GATEWAY_PORT },
      );

      expect(verdict['code']).toBe('SELLER_OWN_LOT');
    } finally {
      await page.context().close();
    }
  });
});
