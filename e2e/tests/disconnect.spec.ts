import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';

import { API_URL } from '../stack';

import { investorPage, lotInAuction } from './arena';

/**
 * Обрыв связи и ресинк (T-054, QA-03).
 *
 * ТЗ §6 требует: при переподключении клиента UI мгновенно ресинкает время с
 * сервером. Проверяется в настоящем браузере во всех трёх статусах сессии —
 * RUNNING, FROZEN, FINISHED, — потому что ресинк в каждом означает разное и
 * ломается в каждом по-своему.
 *
 * В зале всегда есть здоровые соседи, кроме сценария заморозки. Это не
 * декорация: доля деградировавших клиентов больше 40 % уводит лот в SLA Freeze
 * (ТЗ §2.2), и обрыв у ЕДИНСТВЕННОГО участника останавливает торги целиком.
 * Первая версия теста об это и споткнулась — сервер честно замораживал лот,
 * пока тест ждал, что время идёт.
 */

/** Тик таймера — 1000 мс (ТЗ §2.1). Ровно на столько экрану позволено отстать. */
const TICK_MS = 1_000;

/**
 * Управляемый обрыв связи страницы.
 *
 * Два действия, и оба нужны. `setOffline` не даёт открыть НОВОЕ соединение, но
 * уже открытый сокет продолжает получать кадры — обрыв им не изобразить.
 * Перехват сокета, наоборот, позволяет закрыть текущее соединение, но не
 * мешает клиенту тут же переподключиться. Вместе получается то, что бывает при
 * пропавшем Wi-Fi: связи нет и не появляется, пока её не вернут.
 */
interface Link {
  cut(): Promise<void>;
  restore(): Promise<void>;
}

async function breakable(page: Page): Promise<Link> {
  const live = new Set<WebSocketRoute>();

  await page.routeWebSocket(/.*/, (ws) => {
    // Без обработчиков сообщений Playwright просто перекладывает кадры в обе
    // стороны — перехватчик прозрачен, пока связь цела.
    ws.connectToServer();
    live.add(ws);
    ws.onClose(() => live.delete(ws));
  });

  return {
    async cut(): Promise<void> {
      // Сначала запрет на новые соединения, потом обрыв текущего: в обратном
      // порядке клиент успевает переподключиться в промежутке.
      await page.context().setOffline(true);
      for (const ws of live) {
        await ws.close();
      }
      live.clear();
    },
    async restore(): Promise<void> {
      await page.context().setOffline(false);
    },
  };
}

function timerOf(page: Page): ReturnType<Page['getByText']> {
  return page.getByText(/^\d{2}\.\d{3}$/);
}

/** «47.512» на табло — это 47512 мс. */
function parseTimer(text: string | null): number {
  const [seconds = '0', millis = '0'] = (text ?? '0.0').split('.');
  return Number(seconds) * 1000 + Number(millis);
}

interface Snapshot {
  readonly status: string;
  readonly timeRemainingMs: number;
  readonly resumeInMs: number | null;
}

/**
 * Насколько экран отстал от сервера.
 *
 * Сначала читается ЭКРАН, потом сервер: за время между двумя чтениями остаток
 * на сервере успевает уменьшиться, поэтому такой порядок даёт одностороннюю
 * границу — расхождение не может оказаться отрицательным по вине самого
 * замера. Длительность промежутка возвращается отдельно и прибавляется к
 * допуску: спрятать её в «разумный запас» значило бы спрятать там же и
 * настоящее расхождение.
 */
async function drift(
  page: Page,
  api: APIRequestContext,
  lotId: string,
): Promise<{ ms: number; slackMs: number; server: Snapshot }> {
  const startedAt = Date.now();
  const shown = parseTimer(await timerOf(page).textContent());
  const response = await api.get(`${API_URL}/api/lots/${lotId}/auction`);
  const server = (await response.json()) as Snapshot;
  return { ms: shown - server.timeRemainingMs, slackMs: Date.now() - startedAt, server };
}

/**
 * Сумма из подписи кнопки «Сделать ставку +3 % · 46 350 000 ₸».
 *
 * Берётся часть после разделителя: иначе тройка из «+3 %» приклеивается к
 * цене. Разряды браузер разделяет неразрывным пробелом, поэтому вынимаются
 * цифры, а не сравнивается строка.
 */
function priceOf(text: string): number {
  return Number((text.split('·').pop() ?? '').replace(/\D/gu, ''));
}

/** Открыть зал и дождаться, пока он отрисуется. */
async function openHall(page: Page, lotId: string): Promise<void> {
  await page.goto(`/lots/${lotId}`);
  await expect(page.getByText('Торговый зал')).toBeVisible();
}

test.describe('T-054: обрыв связи и ресинк', () => {
  /**
   * Идущие торги. Обрыв на двенадцать секунд — нижний край диапазона 10–120 с
   * из плана; верхний закрывает сценарий с завершением, где клиента нет
   * больше минуты.
   */
  test('DoD: RUNNING — после обрыва остаток сходится с сервером в пределах тика', async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const { lotId } = await lotInAuction(request);

    // Двое остаются на связи: без них обрыв у третьего — это 100 % зала, и
    // сервер по праву заморозил бы торги вместо того, чтобы их продолжать.
    const away = await investorPage(browser, request, lotId);
    const first = await investorPage(browser, request, lotId);
    const second = await investorPage(browser, request, lotId);
    const link = await breakable(away.page);

    try {
      for (const page of [away.page, first.page, second.page]) {
        await openHall(page, lotId);
      }
      const timer = timerOf(away.page);
      await expect(timer).not.toHaveText('00.000', { timeout: 20_000 });

      await link.cut();

      /**
       * Ставка соседа делает две вещи сразу.
       *
       * Возвращает отсчёт к пятидесяти секундам — иначе торги успевают
       * закрыться по тишине прямо посреди сценария, и проверять ресинк
       * идущих торгов становится не на чем. И создаёт событие, которого
       * отсутствующий не увидит: вернуться он обязан не только с верным
       * временем, но и с верной ценой.
       */
      const missedButton = first.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(missedButton).toBeEnabled();
      await missedButton.click();
      await expect(first.page.getByText('Ставка принята.')).toBeVisible();
      const priceAfterBid = priceOf((await missedButton.textContent()) ?? '');

      // Даём улететь тику, который мог быть уже в пути на момент обрыва.
      await away.page.waitForTimeout(1_500);
      const stalled = await timer.textContent();
      await away.page.waitForTimeout(10_500);

      // Таймер замер — это и есть доказательство, что обрыв настоящий. Свой
      // обратный отсчёт клиент не ведёт принципиально: время только серверное.
      expect(await timer.textContent(), 'на оборванной связи таймер обязан замереть').toBe(stalled);

      // Торги при этом шли: расхождение выросло на длину обрыва.
      const gone = await drift(away.page, request, lotId);
      expect(gone.server.status, 'зал остался жив — заморозки быть не должно').toBe('RUNNING');
      expect(gone.ms, 'за двенадцать секунд отсутствия экран обязан отстать').toBeGreaterThan(
        9_000,
      );

      await link.restore();
      await expect(away.page.getByText('связь есть')).toBeVisible({ timeout: 30_000 });

      const after = await drift(away.page, request, lotId);
      expect(after.server.status).toBe('RUNNING');
      expect(
        after.ms,
        `экран ушёл ВПЕРЁД сервера на ${String(-after.ms)} мс`,
      ).toBeGreaterThanOrEqual(-after.slackMs);
      expect(
        after.ms,
        `отставание ${String(after.ms)} мс при допуске ${String(TICK_MS + after.slackMs)} мс`,
      ).toBeLessThanOrEqual(TICK_MS + after.slackMs);

      // Снимок вернул и право ставить, и цену — ту, что сложилась без него.
      const button = away.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(button).toBeEnabled();
      expect(
        priceOf((await button.textContent()) ?? ''),
        'вернувшийся обязан увидеть цену после чужой ставки, а не свою прежнюю',
      ).toBe(priceAfterBid);
    } finally {
      await link.restore();
      for (const page of [away.page, first.page, second.page]) {
        await page.context().close();
      }
    }
  });

  /**
   * Пауза SLA Freeze.
   *
   * Здесь ресинк означает больше, чем «правильное число»: вернувшийся обязан
   * увидеть, ЧТО идёт пауза. Событие `sla_freeze` получают только те, кто был
   * на связи в момент заморозки, поэтому для остальных единственный источник —
   * снимок.
   */
  test('DoD: FROZEN — вернувшийся видит паузу и замороженный остаток', async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const { lotId } = await lotInAuction(request);

    const alive = await investorPage(browser, request, lotId);
    const lostOne = await investorPage(browser, request, lotId);
    const lostTwo = await investorPage(browser, request, lotId);
    const link = await breakable(alive.page);

    try {
      for (const page of [alive.page, lostOne.page, lostTwo.page]) {
        await openHall(page, lotId);
      }

      // Ставка возвращает отсчёт к пятидесяти секундам: заморозке нужно около
      // десяти секунд на пять неотвеченных ping, и без сброса торги успевали бы
      // закрыться по тишине раньше, чем наступит пауза.
      const bid = alive.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(bid).toBeEnabled();
      await bid.click();
      await expect(alive.page.getByText('Ставка принята.')).toBeVisible();

      // Двое из трёх теряют связь — больше 40 % зала, порог ТЗ §2.2.
      await lostOne.page.context().setOffline(true);
      await lostTwo.page.context().setOffline(true);

      const banner = alive.page.getByRole('status').filter({ hasText: 'SLA Freeze' });
      await expect(banner).toBeVisible({ timeout: 60_000 });

      // Таймер на паузе обязан стоять. До правки тик приносил остаток,
      // посчитанный из дедлайна, и тот продолжал убывать при живых торгах.
      const held = await timerOf(alive.page).textContent();
      await alive.page.waitForTimeout(3_000);
      expect(await timerOf(alive.page).textContent(), 'на паузе таймер обязан стоять').toBe(held);

      await link.cut();
      await alive.page.waitForTimeout(10_000);
      await link.restore();
      await expect(alive.page.getByText('связь есть')).toBeVisible({ timeout: 30_000 });

      const after = await drift(alive.page, request, lotId);
      expect(after.server.status).toBe('FROZEN');
      // Пауза остановила время: расхождение здесь не «в пределах тика», а нулевое.
      expect(after.ms, 'на паузе остаток обязан совпасть точно').toBe(0);
      expect(after.server.resumeInMs ?? 0).toBeGreaterThan(0);

      // И главное — вернувшийся понимает, ПОЧЕМУ таймер стоит.
      await expect(banner, 'баннер паузы обязан пережить переподключение').toBeVisible();
      await expect(alive.page.getByRole('button', { name: /Сделать ставку/ })).toBeDisabled();
    } finally {
      await link.restore();
      await lostOne.page.context().setOffline(false);
      await lostTwo.page.context().setOffline(false);
      for (const page of [alive.page, lostOne.page, lostTwo.page]) {
        await page.context().close();
      }
    }
  });

  /**
   * Торги, закрывшиеся без участника.
   *
   * Самый длинный обрыв: клиент уходит до конца отсчёта и возвращается уже
   * после закрытия. О завершении он узнаёт единственным способом — из снимка,
   * потому что событие `auction_finished` ушло в комнату, где его уже не было.
   */
  test('DoD: FINISHED — вернувшийся после закрытия узнаёт о нём из снимка', async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const { lotId } = await lotInAuction(request);

    const away = await investorPage(browser, request, lotId);
    const first = await investorPage(browser, request, lotId);
    const second = await investorPage(browser, request, lotId);
    const link = await breakable(away.page);

    try {
      for (const page of [away.page, first.page, second.page]) {
        await openHall(page, lotId);
      }

      // Ставка нужна, чтобы у торгов был победитель, а у закрытия — смысл.
      const button = away.page.getByRole('button', { name: /Сделать ставку/ });
      await expect(button).toBeEnabled();
      await button.click();
      await expect(away.page.getByText('Ставка принята.')).toBeVisible();

      await link.cut();

      // Пятьдесят секунд тишины плюс запас на разбор очереди finisher'ом.
      // Ускорить нельзя: время торгов задаёт сервер, и подкрутить его снаружи
      // значило бы проверять не ту систему. Двое оставшихся на связи не дают
      // залу уйти в паузу — иначе отсчёт остановился бы вместе с ним.
      await first.page.waitForTimeout(62_000);
      await expect(
        first.page.getByRole('dialog').filter({ hasText: 'Торги завершены' }),
        'у оставшихся торги обязаны закрыться по тишине',
      ).toBeVisible({ timeout: 30_000 });

      await link.restore();

      // Вернувшемуся модалку приносит снимок: событие ушло в комнату, где его
      // уже не было.
      const modal = away.page.getByRole('dialog').filter({ hasText: 'Торги завершены' });
      await expect(modal, 'о закрытии обязан рассказать снимок').toBeVisible({ timeout: 40_000 });
      await expect(modal).toContainText(/Инвестор #\d{3,5}/);

      const after = await drift(away.page, request, lotId);
      expect(after.server.status).toBe('FINISHED');
      expect(after.server.timeRemainingMs).toBe(0);
      // Закрытые торги — это ноль на табло, а не остаток «как было».
      expect(after.ms).toBe(0);
    } finally {
      await link.restore();
      for (const page of [away.page, first.page, second.page]) {
        await page.context().close();
      }
    }
  });
});
