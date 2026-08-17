import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { API_URL, repoRoot } from '../e2e/stack';

/**
 * Подготовка сцены для нагрузочного прогона (T-051).
 *
 * Поднимает лот в идущих торгах и заводит участников с задатками, чтобы
 * ставки доходили до ядра, а не отбивались проверкой прав. Иначе замер
 * «задержки обработки ставки» мерил бы отказ гварда.
 *
 * Пишет `load/.seed.json` — его читает k6.
 */

const BIDDERS = Number(process.env['BIDDERS'] ?? '40');

interface Seed {
  readonly lotId: string;
  readonly tokens: readonly string[];
}

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

async function post(path: string, body?: unknown, token?: string): Promise<unknown> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${String(response.status)} ${await response.text()}`);
  }
  return response.json();
}

async function patch(path: string, body: unknown, token: string): Promise<void> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${String(response.status)}`);
  }
}

/** Полный eGov-вход: другого способа получить верифицированного человека нет. */
async function egovLogin(): Promise<string> {
  const init = (await post('/api/auth/egov/init')) as { sessionId: string };
  await post('/api/auth/egov/dev-approve', {
    sessionId: init.sessionId,
    iin: randomIin(),
    fio: 'Нагрузочный Участник',
    biometricConfirmed: true,
  });
  const done = (await post('/api/auth/egov/complete', { sessionId: init.sessionId })) as {
    status: string;
    tokens?: { accessToken: string };
  };
  if (done.status !== 'COMPLETED' || done.tokens === undefined) {
    throw new Error('eGov-вход не завершился');
  }
  return done.tokens.accessToken;
}

async function main(): Promise<void> {
  const admin = (await post('/api/auth/dev-login', { roles: ['ADMIN'] })) as {
    accessToken: string;
  };

  const sellerToken = await egovLogin();
  const me = await fetch(`${API_URL}/api/auth/me`, {
    headers: { authorization: `Bearer ${sellerToken}` },
  });
  const sellerId = ((await me.json()) as { id: string }).id;
  await patch(
    `/api/admin/users/${sellerId}/roles`,
    { roles: ['INVESTOR', 'SELLER'], reason: 'нагрузочный прогон' },
    admin.accessToken,
  );

  const lot = (await post(
    '/api/lots',
    {
      type: 'REALTY',
      cadastreOrVin: `LOAD-${String(Math.floor(Math.random() * 1e9))}`,
      startPriceTenge: 45_000_000,
    },
    sellerToken,
  )) as { id: string };

  await post(`/api/lots/${lot.id}/submit`, {}, sellerToken);
  for (const to of ['PHASE_I', 'PHASE_II'] as const) {
    await patch(
      `/api/admin/lots/${lot.id}/status`,
      { to, reason: 'нагрузочный прогон' },
      admin.accessToken,
    );
  }
  await post(`/api/admin/lots/${lot.id}/auction/start`, {}, admin.accessToken);

  const tokens: string[] = [];
  for (let index = 0; index < BIDDERS; index += 1) {
    const token = await egovLogin();
    await post(`/api/lots/${lot.id}/deposit/invoice`, {}, token);
    await post(`/api/lots/${lot.id}/deposit/dev-pay`, {}, token);
    tokens.push(token);
  }

  const seed: Seed = { lotId: lot.id, tokens };
  writeFileSync(resolve(repoRoot(), 'load', '.seed.json'), JSON.stringify(seed, null, 2), 'utf8');
  console.log(`[load] лот ${lot.id}, участников с задатком: ${String(tokens.length)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
