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
 * База своя — `auction_demo`, и создаётся заново на каждый запуск. Первая
 * версия стенда ходила в рабочую dev-базу и оставляла там всё, что насоздавала:
 * через полчаса каталог показывал полсотни одинаковых лотов по одной цене — то
 * есть ровно то, чего показывать нельзя. Демо-данные живут в демо-базе.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
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
const demoUrl = new URL(process.env.DATABASE_URL);
demoUrl.pathname = '/auction_demo';

const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: demoUrl.toString(),
  DIRECT_URL: demoUrl.toString(),
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

/**
 * Полный eGov-вход — другого способа получить верифицированного человека нет.
 *
 * Возвращается пара целиком, а не один access. Срок его жизни — пятнадцать
 * минут, и первая версия стенда об этом забыла: через пятнадцать минут ставки
 * демо-участников переставали проходить, торги закрывались по тишине, а ссылка,
 * которую человек открывал позже, вела на закрытый лот.
 */
async function egovLogin(fio) {
  const init = await call('/api/auth/egov/init');
  await call('/api/auth/egov/dev-approve', {
    body: { sessionId: init.sessionId, iin: randomIin(), fio, biometricConfirmed: true },
  });
  const done = await call('/api/auth/egov/complete', { body: { sessionId: init.sessionId } });
  return { access: done.tokens.accessToken, refresh: done.tokens.refreshToken };
}

/** Обновить пару. Старый refresh при этом гасится — так задумано в сервере. */
async function refreshTokens(pair) {
  const next = await call('/api/auth/refresh', { body: { refreshToken: pair.refresh } });
  return { access: next.accessToken, refresh: next.refreshToken };
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
  {
    type: 'REALTY',
    object: 'KZ-ALM-01-042-118',
    priceTenge: 46_350_000,
    phase: 'PHASE_III',
    title: 'Трёхкомнатная квартира, ЖК «Асыл Арман»',
    address: 'Алматы, Бостандыкский район, ул. Розыбакиева 247',
    areaSqmX100: 8740,
    buildYear: 2019,
    description:
      'Просторная квартира на девятом этаже двенадцатиэтажного дома, окна во двор. Санузел раздельный, кухня-гостиная, застеклённая лоджия. Дом сдан в 2019 году, паркинг во дворе. Объект свободен от проживающих, продаётся по решению залогодержателя.',
  },
  {
    type: 'REALTY',
    object: 'KZ-AST-02-311-004',
    priceTenge: 78_900_000,
    phase: 'PHASE_II',
    title: 'Коммерческое помещение на первой линии',
    address: 'Астана, район Есиль, проспект Мангилик Ел 55',
    areaSqmX100: 14200,
    buildYear: 2021,
    description:
      'Помещение свободного назначения с отдельным входом и витринными окнами. Подходит под аптеку, банковское отделение или кофейню: пешеходный трафик, парковка на восемь мест. Электрическая мощность 30 кВт, вентиляция заведена.',
  },
  {
    type: 'REALTY',
    object: 'KZ-SHM-03-127-559',
    priceTenge: 21_400_000,
    phase: 'PHASE_I',
    title: 'Двухкомнатная квартира у парка',
    address: 'Шымкент, Аль-Фарабийский район, ул. Тауке хана 41',
    areaSqmX100: 5210,
    buildYear: 2007,
    description:
      'Квартира в кирпичном доме напротив центрального парка. Требует косметического ремонта, планировка не менялась. Продаётся с погашением задолженности перед банком из средств сделки.',
  },
  {
    type: 'VEHICLE',
    object: 'JTDBR32E320012345',
    priceTenge: 12_750_000,
    phase: 'PHASE_II',
    title: 'Toyota Camry 2.5 AT',
    address: 'Алматы, стоянка на пр. Райымбека 212',
    mileageKm: 84_000,
    buildYear: 2021,
    description:
      'Один владелец по документам, сервисная история в официальном дилерском центре. Комплектация Prestige: кожаный салон, камеры кругового обзора, подогрев сидений. Кузов без окрасов, проверка по реестру залогов пройдена.',
  },
  {
    type: 'VEHICLE',
    object: 'WBA3A5C51DF599111',
    priceTenge: 9_300_000,
    phase: 'PHASE_I',
    title: 'BMW 320i xDrive',
    address: 'Караганда, ул. Ерубаева 18, крытый паркинг',
    mileageKm: 142_500,
    buildYear: 2017,
    description:
      'Полный привод, зимняя резина в комплекте. Двигатель и коробка без вмешательств, замена ремня и масла по регламенту. Изымается по решению суда, продаётся с торгов.',
  },
];

async function seed() {
  const admin = (await call('/api/auth/dev-login', { body: { roles: ['ADMIN'] } })).accessToken;

  // Продавцу нужен только access: он ничего не делает дольше пятнадцати минут.
  const sellerToken = (await egovLogin('Демонстрационный Продавец')).access;
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
        // База чистая на каждый запуск, поэтому номер объекта настоящий, без
        // случайного хвоста: он и должен выглядеть как кадастровый номер.
        cadastreOrVin: item.object,
        startPriceTenge: item.priceTenge,
        title: item.title,
        address: item.address,
        description: item.description,
        ...(item.areaSqmX100 === undefined ? {} : { areaSqmX100: item.areaSqmX100 }),
        ...(item.mileageKm === undefined ? {} : { mileageKm: item.mileageKm }),
        ...(item.buildYear === undefined ? {} : { buildYear: item.buildYear }),
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
  const investors = await openTrading(live.id, admin);

  return { live, created, admin, sellerToken, investors };
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

  // Двое, а не один: перебивать собственную последнюю ставку запрещено, и
  // поддерживать торги живыми в одиночку невозможно — как и в реальности.
  const investors = [];
  for (const fio of ['Демонстрационный Инвестор', 'Второй Инвестор Демо']) {
    const pair = await egovLogin(fio);
    await call(`/api/lots/${lotId}/deposit/invoice`, { token: pair.access });
    await call(`/api/lots/${lotId}/deposit/dev-pay`, { token: pair.access });
    investors.push(pair);
  }

  await placeBid(lotId, investors[0]);
  return investors;
}

/**
 * Поставить по сокету — единственным способом, каким это вообще делается.
 *
 * REST-ручки для ставки нет и не будет: сумму назначает сервер, а событие
 * рассылается всем в комнате тем же атомарным скриптом, который ставку принял.
 * Демо ходит ровно тем же путём, что браузер участника, — иначе оно
 * показывало бы систему, которой не существует.
 */
async function placeBid(lotId, pair) {
  const token = pair.access;
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
      // `error` — это отказ до ставки: протухший токен, чужой лот, кривой кадр.
      // Без этой ветки стенд просто висел пятнадцать секунд и не понимал, что
      // именно сломалось.
      if (payload.event === 'error') {
        clearTimeout(timer);
        socket.close();
        fail(new Error(`сокет отказал: ${String(payload.code ?? 'UNKNOWN')}`));
      }
    });
    socket.addEventListener('error', (error) => {
      clearTimeout(timer);
      fail(new Error(String(error?.message ?? 'сокет не открылся')));
    });
  });
}

/**
 * Держать торги живыми — ПОВЕДЕНИЕ ТОЛЬКО ДЕМО-СТЕНДА.
 *
 * Пятьдесят секунд тишины закрывают лот навсегда, и это правило системы. Но
 * ссылка, которую даёшь человеку, не должна протухать за минуту: открыв её
 * через полчаса, он обязан увидеть идущие торги, а не архив.
 *
 * Первая версия стенда на месте закрывшегося лота открывала новый — и за час
 * наплодила полсотни одинаковых карточек, превратив каталог в свалку. Поэтому
 * теперь лот один и тот же, а живым он остаётся ставками: два демо-участника
 * ставят по очереди раз в тридцать пять секунд. Перебивать самого себя нельзя —
 * отсюда и двое. Цена при этом растёт по-настоящему, шагами +3 %, как и должна.
 */
function keepAlive(state) {
  const BID_EVERY_MS = 35_000;
  const REFRESH_EVERY_MS = 10 * 60_000;

  const refresher = setInterval(() => {
    void (async () => {
      try {
        state.investors = await Promise.all(state.investors.map((pair) => refreshTokens(pair)));
      } catch (error) {
        // Обновление не удалось — входим заново: демо-участник дешёвый.
        console.error(
          '[демо] токены не обновились, вхожу заново:',
          error instanceof Error ? error.message : error,
        );
        state.investors = await Promise.all(
          ['Демонстрационный Инвестор', 'Второй Инвестор Демо'].map((fio) => egovLogin(fio)),
        );
        for (const pair of state.investors) {
          await call(`/api/lots/${state.liveId}/deposit/invoice`, { token: pair.access });
          await call(`/api/lots/${state.liveId}/deposit/dev-pay`, { token: pair.access });
        }
      }
    })();
  }, REFRESH_EVERY_MS);
  refresher.unref?.();

  const timer = setInterval(() => {
    void (async () => {
      try {
        const lot = await call(`/api/lots/${state.liveId}`, { method: 'GET' });
        if (lot.status !== 'PHASE_III') {
          // Торги всё-таки закрылись — открываем следующий лот витрины и
          // говорим новый адрес. Молчать нельзя: ссылка у человека уже на руках.
          await promoteNextLot(state);
          return;
        }
        state.turn = (state.turn + 1) % state.investors.length;
        await placeBid(state.liveId, state.investors[state.turn]);
      } catch (error) {
        console.error('[демо] ставка не прошла:', error instanceof Error ? error.message : error);
      }
    })();
  }, BID_EVERY_MS);
  timer.unref?.();
}

/** Вывести в торги следующий лот витрины, если прежний закрылся. */
async function promoteNextLot(state) {
  const candidates = await call('/api/lots?status=PHASE_II&pageSize=1', { method: 'GET' });
  const next = candidates.items?.[0];
  if (next === undefined) {
    console.log('[демо] свободных лотов в Фазе II не осталось — перезапустите pnpm demo');
    return;
  }
  state.investors = await openTrading(next.id, state.admin);
  state.liveId = next.id;
  state.turn = 0;
  console.log(`[демо] прежние торги закрылись, новые здесь: ${WEB_URL}/lots/${next.id}`);
}

/**
 * Пересоздать демо-базу и накатить миграции.
 *
 * Каждый запуск с чистого листа: демо показывает витрину, а не археологию
 * прошлых прогонов. Рабочую базу это не трогает — у демо своя.
 */
function resetDemoDatabase() {
  const admin = new URL(demoUrl.toString());
  admin.pathname = '/postgres';
  const query = (sql) =>
    spawnSync(
      process.execPath,
      [
        '-e',
        `const {Client}=require(${JSON.stringify(resolve(ROOT, 'e2e/node_modules/pg'))});` +
          `const c=new Client(${JSON.stringify(admin.toString())});` +
          `c.connect().then(()=>c.query(${JSON.stringify(sql)})).then(()=>c.end()).catch((e)=>{console.error(e.message);process.exit(1)})`,
      ],
      { stdio: 'inherit' },
    );

  // Отключаем чужие соединения: своя же прошлая копия стенда могла остаться.
  query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'auction_demo' AND pid <> pg_backend_pid()`,
  );
  query('DROP DATABASE IF EXISTS auction_demo');
  if (query('CREATE DATABASE auction_demo').status !== 0) {
    throw new Error('не удалось создать базу auction_demo');
  }

  const migrated = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(ROOT, 'apps/api'),
    env,
    stdio: 'ignore',
    shell: true,
  });
  if (migrated.status !== 0) {
    throw new Error('миграции на демо-базу не накатились');
  }
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
  if (!catalog.includes('Асыл Арман')) {
    throw new Error('каталог отрисовался без названий объектов — витрина не доехала');
  }
}

/**
 * Проверить, что порты свободны.
 *
 * Без этой проверки прошлая копия стенда убивает новую молча: процесс, которому
 * занят порт метрик, просто не поднимается — так и задумано, — а стенд об этом
 * не знает и печатает «поднят». Именно так у воркера и вышло: web с API жили,
 * ставки в базу не доезжали, и понять это по экрану было нельзя.
 */
async function requireFreePorts() {
  const ports = [
    [API_PORT, 'API'],
    [GATEWAY_PORT, 'gateway'],
    [WEB_PORT, 'web'],
    [9484, 'метрики API'],
    [9485, 'метрики gateway'],
    [9486, 'метрики воркера'],
  ];
  const busy = [];
  for (const [port, label] of ports) {
    const free = await new Promise((done) => {
      const probe = createServer();
      probe.once('error', () => {
        done(false);
      });
      probe.once('listening', () => {
        probe.close(() => {
          done(true);
        });
      });
      probe.listen(port, '127.0.0.1');
    });
    if (!free) busy.push(`${String(port)} (${label})`);
  }
  if (busy.length > 0) {
    throw new Error(
      `порты заняты: ${busy.join(', ')}. Обычно это прошлый стенд — остановите его (Ctrl+C) и запустите снова`,
    );
  }
}

try {
  await requireFreePorts();
  console.log('[демо] готовлю чистую базу auction_demo…');
  resetDemoDatabase();
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
  // У воркера нет HTTP-слоя, зато есть порт метрик: другой пробы живости у него
  // не существует, а без воркера ставки не доезжают в базу и торги не
  // закрываются — то есть продукт наполовину мёртв.
  await waitFor('http://127.0.0.1:9486/metrics', 'воркер');
  await waitFor(WEB_URL, 'web');

  const { live, investors, admin } = await seed();
  await smokeCheck(live);
  keepAlive({ liveId: live.id, investors, admin, turn: 0 });

  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('  Демо-стенд поднят');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Каталог:      ${WEB_URL}`);
  console.log(`  Живые торги:  ${WEB_URL}/lots/${live.id}`);
  console.log('                (ссылка постоянная: стенд ставит раз в 35 с и держит торги живыми)');
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
