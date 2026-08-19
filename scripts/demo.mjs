/**
 * Демо-стенд: продукт, который можно открыть и покликать.
 *
 *   pnpm build && pnpm demo
 *
 * Поднимает те же три процесса, что поедут в прод (API, WS-gateway, воркер), и
 * собранный web — не dev-сервер: dev-сервер поверх готового `.next` отдаёт
 * клиентские чанки с 403, страница приходит отрендеренной и не гидратируется,
 * а выглядит это как «нет связи» при живом gateway.
 *
 * Данные наполняются через HTTP теми же ручками, что и настоящий пользователь:
 * лот проходит статусную машину, задаток проходит банк-мок, торги стартуют
 * админской ручкой. Писать напрямую в базу нельзя — так демо показывало бы
 * состояния, которых система сама не создаёт.
 *
 * База — рабочая dev-база (не тестовая): демо остаётся между запусками, и
 * прогон тестов его не сносит. Пространство имён в Redis своё по той же причине.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Порты — те же, что по умолчанию у сборки, и это не свободный выбор.
 *
 * `next.config.ts` вшивает адрес API и порт сокета в сборку (блок `env`), а не
 * читает их при запуске. Стенд на других портах поднимается как ни в чём не
 * бывало, но web ходит по вшитым адресам: каталог оказывается пуст, страница
 * лота отдаёт 404, а сокет стучится не туда. Проверено на себе. Ниже — дымовая
 * проверка, которая ловит именно это.
 */
const API_PORT = 3100;
const GATEWAY_PORT = 3200;
const WEB_PORT = 3101;
const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;

process.loadEnvFile(resolve(ROOT, '.env'));

if (!existsSync(resolve(ROOT, 'apps/api/dist/main.js'))) {
  console.error('Сначала соберите: pnpm build');
  process.exit(1);
}

/**
 * Окружение стенда — `development`, и это не небрежность.
 *
 * Вход-заглушка и мок eGov в production отвечают 404 физически (auth.service.ts),
 * и правильно делают: демонстрационная дверь на боевом контуре — это открытая
 * дверь. Значит показывать продукт можно только вне production. Web при этом
 * запускается собранным и с NODE_ENV=production — иначе Next отдаёт клиентские
 * чанки с 403 и страница не гидратируется.
 */
const env = {
  ...process.env,
  NODE_ENV: 'development',
  API_PORT: String(API_PORT),
  GATEWAY_PORT: String(GATEWAY_PORT),
  API_BASE_URL: API_URL,
  REDIS_NAMESPACE: 'auction-demo',
  LOG_PRETTY: 'false',
};

const children = [];

function start(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: resolve(ROOT, cwd),
    env: { ...env, ...extraEnv },
    stdio: 'ignore',
    shell: command !== process.execPath,
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[демо] ${name} завершился с кодом ${String(code)}`);
    }
  });
  children.push({ name, child });
}

function stopAll() {
  for (const { child } of children) {
    try {
      child.kill();
    } catch {
      /* уже мёртв */
    }
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

async function waitFor(url, label, timeoutMs = 120_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* ещё не поднялся */
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(`${label} не поднялся за ${timeoutMs} мс`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function call(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${String(response.status)} ${await response.text()}`);
  }
  return response.status === 204 ? null : await response.json();
}

/** Случайный ИИН: мок обязан гонять данные того же вида, что боевой eGov. */
function randomIin() {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

/** Полный eGov-вход — другого способа получить верифицированного человека нет. */
async function egovLogin(fio) {
  const init = await call('/api/auth/egov/init');
  await call('/api/auth/egov/dev-approve', {
    body: { sessionId: init.sessionId, iin: randomIin(), fio, biometricConfirmed: true },
  });
  const done = await call('/api/auth/egov/complete', { body: { sessionId: init.sessionId } });
  return done.tokens.accessToken;
}

async function whoami(token) {
  const response = await fetch(`${API_URL}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()).id;
}

/**
 * Витрина: несколько лотов в разных фазах плюс один в идущих торгах.
 *
 * Разные фазы нужны не для красоты: каталог обязан показывать лот по-разному в
 * зависимости от того, что с ним сейчас можно делать, и одна карточка этого не
 * покажет.
 */
const CATALOG = [
  { type: 'REALTY', object: 'KZ-ALM-01-042-118', priceTenge: 46_350_000, phase: 'PHASE_III' },
  { type: 'REALTY', object: 'KZ-AST-02-311-004', priceTenge: 78_900_000, phase: 'PHASE_II' },
  { type: 'REALTY', object: 'KZ-SHM-03-127-559', priceTenge: 21_400_000, phase: 'PHASE_I' },
  { type: 'VEHICLE', object: 'JTDBR32E320012345', priceTenge: 12_750_000, phase: 'PHASE_II' },
  { type: 'VEHICLE', object: 'WBA3A5C51DF599111', priceTenge: 9_300_000, phase: 'PHASE_I' },
];

async function seed() {
  const admin = (await call('/api/auth/dev-login', { body: { roles: ['ADMIN'] } })).accessToken;

  const sellerToken = await egovLogin('Демонстрационный Продавец');
  const sellerId = await whoami(sellerToken);
  await call(`/api/admin/users/${sellerId}/roles`, {
    method: 'PATCH',
    token: admin,
    body: { roles: ['INVESTOR', 'SELLER'], reason: 'демо-стенд' },
  });

  const created = [];
  for (const item of CATALOG) {
    const lot = await call('/api/lots', {
      token: sellerToken,
      body: {
        type: item.type,
        cadastreOrVin: `${item.object}-${String(Math.floor(Math.random() * 1000))}`,
        startPriceTenge: item.priceTenge,
      },
    });
    await call(`/api/lots/${lot.id}/submit`, { token: sellerToken });
    for (const to of ['PHASE_I', 'PHASE_II']) {
      if (item.phase === 'PHASE_I' && to === 'PHASE_II') break;
      await call(`/api/admin/lots/${lot.id}/status`, {
        method: 'PATCH',
        token: admin,
        body: { to, reason: 'демо-стенд' },
      });
    }
    created.push({ ...item, id: lot.id });
  }

  const live = created.find((lot) => lot.phase === 'PHASE_III');
  await openTrading(live.id, admin);

  return { live, created, admin, sellerToken };
}

/**
 * Открыть торги и оставить в ленте одну ставку.
 *
 * Ставка нужна, чтобы зал не выглядел пустым: она показывает ленту, псевдоним
 * участника и шаг +3 %. Ставит настоящий участник с настоящим задатком —
 * другого способа поставить в этой системе нет, и подделывать его на демо
 * означало бы показывать не тот продукт.
 */
async function openTrading(lotId, admin) {
  await call(`/api/admin/lots/${lotId}/auction/start`, { token: admin });

  const token = await egovLogin('Демонстрационный Инвестор');
  await call(`/api/lots/${lotId}/deposit/invoice`, { token });
  await call(`/api/lots/${lotId}/deposit/dev-pay`, { token });

  await placeBid(lotId, token);
}

/**
 * Поставить по сокету — единственным способом, каким это вообще делается.
 *
 * REST-ручки для ставки нет и не будет: сумму назначает сервер, а событие
 * рассылается всем в комнате тем же атомарным скриптом, который ставку принял.
 * Демо ходит ровно тем же путём, что браузер участника, — иначе оно
 * показывало бы систему, которой не существует.
 */
async function placeBid(lotId, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${String(GATEWAY_PORT)}`);
  await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      fail(new Error('ставка по сокету не прошла за 15 с'));
    }, 15_000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ event: 'join_lot', lot_id: lotId, token }));
    });
    socket.addEventListener('message', (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.event === 'state_snapshot') {
        socket.send(
          JSON.stringify({
            event: 'place_bid',
            lot_id: lotId,
            amount_kzt: payload.next_price_kzt,
            // Поведенческие сигналы — как у живого клика (FR-11): без них
            // антибот попросит капчу, и он будет прав.
            behavior: { trusted: true, kind: 'mouse', moves: 20, path_px: 260, dwell_ms: 180 },
          }),
        );
      }
      if (payload.event === 'bid_accepted' || payload.event === 'bid_rejected') {
        clearTimeout(timer);
        socket.close();
        done(payload);
      }
    });
    socket.addEventListener('error', (error) => {
      clearTimeout(timer);
      fail(new Error(String(error?.message ?? 'сокет не открылся')));
    });
  });
}

/**
 * Держать один лот в идущих торгах — ПОВЕДЕНИЕ ТОЛЬКО ДЕМО-СТЕНДА.
 *
 * Пятьдесят секунд тишины закрывают лот навсегда, и это правило системы, а не
 * недосмотр: в проде закрытый лот закрыт. Но человек, открывший ссылку через
 * полчаса после запуска стенда, должен увидеть живые торги, а не пять
 * завершённых. Поэтому здесь, и только здесь, на месте закрывшегося лота
 * открывается следующий.
 */
function keepOneLive(state) {
  const CHECK_MS = 10_000;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const lot = await call(`/api/lots/${state.liveId}`, { method: 'GET' });
        if (lot.status === 'PHASE_III') return;

        const seller = state.sellerToken;
        const fresh = await call('/api/lots', {
          token: seller,
          body: {
            type: 'REALTY',
            cadastreOrVin: `KZ-ALM-01-042-${String(Math.floor(Math.random() * 1_000_000))}`,
            startPriceTenge: 46_350_000,
          },
        });
        await call(`/api/lots/${fresh.id}/submit`, { token: seller });
        for (const to of ['PHASE_I', 'PHASE_II']) {
          await call(`/api/admin/lots/${fresh.id}/status`, {
            method: 'PATCH',
            token: state.admin,
            body: { to, reason: 'демо-стенд: следующие торги' },
          });
        }
        await openTrading(fresh.id, state.admin);
        state.liveId = fresh.id;
        console.log(
          `[демо] прежний лот закрылся, открыты новые торги: ${WEB_URL}/lots/${fresh.id}`,
        );
      } catch (error) {
        console.error(
          '[демо] не удалось открыть следующие торги:',
          error instanceof Error ? error.message : error,
        );
      }
    })();
  }, CHECK_MS);
  timer.unref?.();
}

/**
 * Дымовая проверка: web действительно показывает то, что создано.
 *
 * Не формальность. Адрес API и порт сокета вшиты в сборку, поэтому стенд,
 * поднятый на других портах, выглядит рабочим: процессы живы, health отвечает,
 * а каталог пуст и страница лота отдаёт 404. Лучше упасть здесь с понятным
 * текстом, чем отдать человеку ссылку на пустоту.
 */
async function smokeCheck(live) {
  const page = await fetch(`${WEB_URL}/lots/${live.id}`);
  if (!page.ok) {
    throw new Error(
      `страница лота отвечает HTTP ${String(page.status)}. Обычно это значит, что сборка сделана ` +
        `с другими портами: пересоберите (pnpm build) и запустите снова`,
    );
  }
  const catalog = await (await fetch(`${WEB_URL}/`)).text();
  if (!catalog.includes('₸')) {
    throw new Error('каталог отрисовался без цен — web не достучался до API');
  }
}

try {
  console.log('[демо] поднимаю API, gateway, воркер и web…');
  start('api', process.execPath, ['dist/main.js'], 'apps/api', { METRICS_PORT: '9484' });
  start('gateway', process.execPath, ['dist/main.gateway.js'], 'apps/api', {
    METRICS_PORT: '9485',
  });
  start('worker', process.execPath, ['dist/main.worker.js'], 'apps/api', { METRICS_PORT: '9486' });
  start('web', 'pnpm', ['exec', 'next', 'start', '-p', String(WEB_PORT)], 'apps/web', {
    NODE_ENV: 'production',
    PORT: String(WEB_PORT),
    API_PORT: String(API_PORT),
  });

  await waitFor(`${API_URL}/api/health`, 'API');
  await waitFor(`http://127.0.0.1:${String(GATEWAY_PORT)}/health`, 'gateway');
  await waitFor(WEB_URL, 'web');

  const { live, admin, sellerToken } = await seed();
  await smokeCheck(live);
  const liveState = { liveId: live.id, admin, sellerToken };
  keepOneLive(liveState);

  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('  Демо-стенд поднят');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Каталог:      ${WEB_URL}`);
  console.log(`  Живые торги:  ${WEB_URL}/lots/${live.id}`);
  console.log('                (закроются по тишине — стенд сам откроет следующие)');
  console.log(`  Вход:         ${WEB_URL}/login`);
  console.log(`  Кабинет:      ${WEB_URL}/seller  и  ${WEB_URL}/partner`);
  console.log(`  API и /docs:  ${API_URL}/docs`);
  console.log('');
  console.log('  Как проверить главное:');
  console.log('   1. Откройте зал торгов, войдите как инвестор (eGov) на /login,');
  console.log('      внесите задаток на карточке лота и жмите «Сделать ставку +3 %».');
  console.log('   2. Откройте тот же зал во втором окне и ставьте по очереди:');
  console.log('      таймер сбрасывается в 50 секунд у обоих, свою ставку перебить нельзя.');
  console.log('   3. Замолчите на 50 секунд — торги закроются протоколом у всех сразу.');
  console.log('');
  console.log('  Ctrl+C останавливает стенд.');
  console.log('');
} catch (error) {
  console.error('[демо] не поднялось:', error instanceof Error ? error.message : error);
  stopAll();
  process.exit(1);
}
