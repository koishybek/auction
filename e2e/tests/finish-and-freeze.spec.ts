import { expect, test, type Page } from '@playwright/test';

import { investorPage, lotInAuction } from './arena';

/**
 * Модалки завершения и баннер паузы (T-040, FR-07/FR-08/FR-14).
 *
 * DoD плана: события WS вызывают нужные модалки у ВСЕХ клиентов комнаты,
 * проверка на трёх клиентах. Тремя браузерными контекстами — тремя разными
 * людьми, а не тремя вкладками одного.
 */

/** Пятьдесят секунд тишины плюс запас на разбор очереди finisher'ом. */
const SILENCE_MS = 58_000;

async function bid(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /Сделать ставку/ });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText('Ставка принята.')).toBeVisible();
}

test.describe('T-040: завершение и пауза', () => {
  test('DoD: модалка завершения приходит всем трём клиентам', async ({ browser, request }) => {
    test.setTimeout(150_000);
    const { lotId } = await lotInAuction(request);

    const second = await investorPage(browser, request, lotId);
    const winner = await investorPage(browser, request, lotId);
    const watcher = await investorPage(browser, request, lotId);
    const pages = [second.page, winner.page, watcher.page];

    try {
      for (const page of pages) {
        await page.goto(`/lots/${lotId}`);
        await expect(page.getByText('Торговый зал')).toBeVisible();
      }

      // Ставят двое: последний становится победителем, предпоследний — №2.
      await bid(second.page);
      // Пауза не для устойчивости теста, а по правилу FR-10: не чаще одной
      // ставки в 500 мс с одного адреса. Все браузеры стенда сидят на
      // 127.0.0.1, и без паузы вторая ставка законно получает RATE_LIMITED.
      await winner.page.waitForTimeout(700);
      await bid(winner.page);

      // Пятьдесят секунд тишины — то самое условие Smart Hammer. Ускорить
      // нельзя: время торгов задаёт сервер, и подкрутить его снаружи значило
      // бы проверять не ту систему.
      await winner.page.waitForTimeout(SILENCE_MS);

      for (const page of pages) {
        const modal = page.getByRole('dialog').filter({ hasText: 'Торги завершены' });
        await expect(modal, 'модалка обязана прийти каждому в комнате').toBeVisible({
          timeout: 20_000,
        });
        // Победитель назван псевдонимом — реальных имён нет и после торгов.
        await expect(modal).toContainText(/Инвестор #\d{3,5}/);
      }

      // Участнику №2 дополнительно предложен выбор (FR-14).
      const runnerUpModal = second.page.getByRole('dialog').filter({ hasText: 'второй участник' });
      await expect(runnerUpModal).toBeVisible({ timeout: 20_000 });
      await expect(runnerUpModal).toContainText('Оставить задаток на 5 дней');

      // Победителю и постороннему такого окна не показывают.
      for (const page of [winner.page, watcher.page]) {
        await expect(page.getByRole('dialog').filter({ hasText: 'второй участник' })).toHaveCount(
          0,
        );
      }

      // Выбор доводится до конца: Опция А оставляет задаток на пять дней.
      await runnerUpModal.getByRole('button', { name: 'Оставить задаток на 5 дней' }).click();
      await expect(runnerUpModal).toBeHidden({ timeout: 10_000 });
    } finally {
      for (const page of pages) {
        await page.context().close();
      }
    }
  });

  test('баннер паузы появляется у клиента, который остался на связи', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const { lotId } = await lotInAuction(request);

    const alive = await investorPage(browser, request, lotId);
    const first = await investorPage(browser, request, lotId);
    const secondLost = await investorPage(browser, request, lotId);

    try {
      for (const page of [alive.page, first.page, secondLost.page]) {
        await page.goto(`/lots/${lotId}`);
        await expect(page.getByText('Торговый зал')).toBeVisible();
      }

      // Двое из трёх теряют связь — это больше 40 % зала, порог из ТЗ §2.2.
      // Один остаётся на связи и обязан увидеть баннер: пауза объявляется
      // всем, а не только пострадавшим.
      await first.page.context().setOffline(true);
      await secondLost.page.context().setOffline(true);

      await expect(alive.page.getByRole('status').filter({ hasText: 'SLA Freeze' })).toBeVisible({
        timeout: 40_000,
      });
      await expect(alive.page.getByText(/Возобновление через \d+ с/)).toBeVisible();

      // Ставки во время паузы не принимаются: кнопка недоступна.
      await expect(alive.page.getByRole('button', { name: /Сделать ставку/ })).toBeDisabled();
    } finally {
      await first.page.context().setOffline(false);
      await secondLost.page.context().setOffline(false);
      for (const page of [alive.page, first.page, secondLost.page]) {
        await page.context().close();
      }
    }
  });
});
