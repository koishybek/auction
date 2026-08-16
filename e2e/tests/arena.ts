import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

import { API_URL, WEB_URL } from '../stack';

/**
 * Подготовка сцены для браузерных тестов.
 *
 * Всё создаётся через настоящие ручки API, а не записью в базу: тест должен
 * идти тем же путём, что живой пользователь, иначе он проверяет собственную
 * фантазию о схеме.
 */

export interface Arena {
  readonly lotId: string;
  readonly adminToken: string;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function devLogin(api: APIRequestContext, roles: readonly string[]): Promise<string> {
  const response = await api.post(`${API_URL}/api/auth/dev-login`, { data: { roles } });
  expect(response.ok(), 'вход-заглушка должен работать вне production').toBeTruthy();
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function randomIin(): string {
  let digits = '';
  for (let index = 0; index < 12; index += 1) {
    digits += String(Math.floor(Math.random() * 10));
  }
  return digits;
}

/** Полный путь eGov: только так получается верифицированный человек. */
async function egovLogin(api: APIRequestContext): Promise<string> {
  const init = await api.post(`${API_URL}/api/auth/egov/init`);
  const sessionId = ((await init.json()) as { sessionId: string }).sessionId;
  await api.post(`${API_URL}/api/auth/egov/dev-approve`, {
    data: { sessionId, iin: randomIin(), fio: 'Тестовый Инвестор', biometricConfirmed: true },
  });
  const done = await api.post(`${API_URL}/api/auth/egov/complete`, { data: { sessionId } });
  const result = (await done.json()) as { status: string; tokens?: { accessToken: string } };
  expect(result.status).toBe('COMPLETED');
  return result.tokens?.accessToken ?? '';
}

async function userIdOf(api: APIRequestContext, token: string): Promise<string> {
  const me = await api.get(`${API_URL}/api/auth/me`, { headers: bearer(token) });
  return ((await me.json()) as { id: string }).id;
}

/** Лот, доведённый до идущих торгов. */
export async function lotInAuction(api: APIRequestContext): Promise<Arena> {
  const adminToken = await devLogin(api, ['ADMIN']);

  const sellerToken = await egovLogin(api);
  const sellerId = await userIdOf(api, sellerToken);
  await api.patch(`${API_URL}/api/admin/users/${sellerId}/roles`, {
    headers: bearer(adminToken),
    data: { roles: ['INVESTOR', 'SELLER'], reason: 'подготовка сцены браузерного теста' },
  });

  const created = await api.post(`${API_URL}/api/lots`, {
    headers: bearer(sellerToken),
    data: {
      type: 'REALTY',
      cadastreOrVin: `20-317-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      startPriceTenge: 45_000_000,
    },
  });
  expect(created.ok()).toBeTruthy();
  const lotId = ((await created.json()) as { id: string }).id;

  await api.post(`${API_URL}/api/lots/${lotId}/submit`, { headers: bearer(sellerToken) });
  for (const to of ['PHASE_I', 'PHASE_II'] as const) {
    await api.patch(`${API_URL}/api/admin/lots/${lotId}/status`, {
      headers: bearer(adminToken),
      data: { to, reason: 'проводка сцены' },
    });
  }
  const started = await api.post(`${API_URL}/api/admin/lots/${lotId}/auction/start`, {
    headers: bearer(adminToken),
  });
  expect(started.ok(), 'торги должны стартовать').toBeTruthy();

  return { lotId, adminToken };
}

/**
 * Вошедший участник с задатком на спецсчёте — в отдельном контексте браузера.
 *
 * Контекст свой у каждого: сессия живёт в куке, и общий контекст означал бы
 * одного человека на всех, а торгам нужны разные.
 */
export async function investorPage(
  browser: Browser,
  api: APIRequestContext,
  lotId: string,
): Promise<{ page: Page; userId: string; blindLabel: () => Promise<string> }> {
  const token = await egovLogin(api);
  const userId = await userIdOf(api, token);

  // Задаток вносится через те же ручки, что и в жизни: счёт и вебхук банка.
  const invoice = await api.post(`${API_URL}/api/lots/${lotId}/deposit/invoice`, {
    headers: bearer(token),
  });
  expect(
    invoice.ok(),
    `счёт на задаток: ${String(invoice.status())} ${await invoice.text()}`,
  ).toBeTruthy();
  const paid = await api.post(`${API_URL}/api/lots/${lotId}/deposit/dev-pay`, {
    headers: bearer(token),
  });
  expect(paid.ok(), 'оплата на моке должна пройти').toBeTruthy();

  const context = await browser.newContext({ baseURL: WEB_URL });
  // Кладём сессию в браузер той же кукой, что выдаёт сервер: страница входа
  // проверяется отдельно, здесь она только мешала бы.
  await context.addCookies([
    {
      name: 'auction_at',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);

  const page = await context.newPage();
  return {
    page,
    userId,
    blindLabel: async () => {
      const response = await api.get(`${API_URL}/api/lots/${lotId}/auction`, {
        headers: bearer(token),
      });
      return JSON.stringify(await response.json());
    },
  };
}
