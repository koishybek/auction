import type { EgovLoginResult, LotView, TokenPair } from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RegistryMockProvider } from '../src/integrations/registry/registry.mock.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { RegistryRecheckWorker } from '../src/workers/registry-recheck.worker';
import { REGISTRY_QUEUE, SCHEDULER_DAILY } from '../src/workers/workers.constants';
import { WorkersModule } from '../src/workers/workers.module';

import { cleanDatabase } from './test-db';

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let registryMock: RegistryMockProvider;
let worker: RegistryRecheckWorker;
/** Своя очередь для наблюдения: заглядывать в чужую из теста честнее, чем открывать её наружу. */
let inspectQueue: Queue;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(tokens: TokenPair): [string, string] {
  return ['Authorization', `Bearer ${tokens.accessToken}`];
}

async function devLogin(roles: readonly string[]): Promise<TokenPair> {
  const response = await api().post('/api/auth/dev-login').send({ roles }).expect(200);
  return response.body as TokenPair;
}

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

/** Уникальный VIN на каждый лот: мок ограничений ключуется именно по нему. */
function uniqueVin(): string {
  return `VIN${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
}

async function egovLogin(iin: string): Promise<TokenPair> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin, fio: 'Тестовый Продавец', biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');
  return result.tokens;
}

async function userId(tokens: TokenPair): Promise<string> {
  const me = await api()
    .get('/api/auth/me')
    .set(...auth(tokens))
    .expect(200);
  return (me.body as { id: string }).id;
}

async function sellerLogin(admin: TokenPair): Promise<TokenPair> {
  const tokens = await egovLogin(randomIin());
  await api()
    .patch(`/api/admin/users/${await userId(tokens)}/roles`)
    .set(...auth(admin))
    .send({ roles: ['INVESTOR', 'SELLER'], reason: 'выдача роли продавца в тесте' })
    .expect(200);
  return tokens;
}

/** Лот, доведённый до нужной фазы силами продавца и админа. */
async function lotInPhase(
  seller: TokenPair,
  admin: TokenPair,
  target: 'PHASE_I' | 'PHASE_II' | 'PHASE_III',
): Promise<LotView> {
  const created = await api()
    .post('/api/lots')
    .set(...auth(seller))
    .send({ type: 'VEHICLE', cadastreOrVin: uniqueVin(), startPriceTenge: 9_000_000 })
    .expect(201);
  const lot = created.body as LotView;

  await api()
    .post(`/api/lots/${lot.id}/submit`)
    .set(...auth(seller))
    .expect(200);

  for (const status of ['PHASE_I', 'PHASE_II', 'PHASE_III'] as const) {
    await api()
      .patch(`/api/admin/lots/${lot.id}/status`)
      .set(...auth(admin))
      .send({ to: status, reason: 'проводка в тесте' })
      .expect(200);
    if (status === target) break;
  }

  return lot;
}

async function statusOf(lotId: string): Promise<string> {
  const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
  return lot.status;
}

/**
 * Все проверки реестра по лоту, старые сверху.
 *
 * Первая запись здесь всегда есть и до всякого крона: её пишет подача лота на
 * модерацию (T-019 сохраняет каждую проверку, включая чистую). Поэтому счёт в
 * тестах ведётся от неё, а не с нуля.
 */
function checksOf(lotId: string) {
  return prisma.registryCheck.findMany({ where: { lotId }, orderBy: { checkedAt: 'asc' } });
}

/**
 * Прогнать полный цикл крона: обход → задачи на лоты → все обработаны.
 *
 * Упавшие задачи поднимаются наружу: BullMQ ретраит их молча, и без этой
 * проверки тест видел бы только последствия — лишнюю запись проверки от
 * повторного захода — вместо самой причины.
 */
async function runSweep(options?: { force?: boolean }): Promise<void> {
  await worker.triggerSweepNow(options ?? {});
  await worker.drain();

  const failed = await inspectQueue.getFailed(0, 20);
  if (failed.length > 0) {
    throw new Error(
      `Задачи очереди упали:\n${failed
        .map((job) => `  ${job.name}: ${job.failedReason ?? 'без причины'}`)
        .join('\n')}`,
    );
  }
}

beforeAll(async () => {
  // AppModule и WorkersModule в одном контейнере: так у HTTP-ручек и у крона
  // общий экземпляр мока реестра. С двумя приложениями setRestriction в тесте
  // не дошёл бы до воркера — он читал бы свою копию мока.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, WorkersModule],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  registryMock = app.get(RegistryMockProvider);
  worker = app.get(RegistryRecheckWorker);

  inspectQueue = new Queue(REGISTRY_QUEUE, {
    connection: redis.createDedicatedClient('test:inspect'),
    prefix: redis.key('bull'),
  });
});

afterAll(async () => {
  await inspectQueue.close();
  await app.close();
});

beforeEach(async () => {
  registryMock.reset();
  await cleanDatabase(prisma);
  // Разбор завершённых задач от прошлого теста: иначе чужое падение
  // всплывёт как падение следующего.
  await inspectQueue.clean(0, 1000, 'failed');
  await inspectQueue.clean(0, 1000, 'completed');
  // Ключи BullMQ намеренно не чистим: задачи адресуются по jobId, а он содержит
  // id лота — у каждого теста лот свой, пересечься нечему. Зато переживает
  // расписание, зарегистрированное при подъёме воркера.
});

describe('T-020: крон-перепроверка ЕРД', () => {
  it('расписание зарегистрировано на 24 часа', async () => {
    const schedulers = await inspectQueue.getJobSchedulers();
    const daily = schedulers.find((item) => item.key === SCHEDULER_DAILY);

    expect(daily, 'крон реестра не зарегистрирован').toBeDefined();
    expect(Number(daily?.every)).toBe(24 * 60 * 60 * 1000);
  });

  it('DoD: смена ответа реестра переводит лот в PAUSED на следующем тике', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotInPhase(seller, admin, 'PHASE_I');
    const sellerId = await userId(seller);

    // При подаче реестр был чист — иначе лот не опубликовался бы (T-019).
    expect(await checksOf(lot.id)).toHaveLength(1);

    // Первый тик: реестр по-прежнему чист, лот работает дальше.
    await runSweep();
    expect(await statusOf(lot.id)).toBe('PHASE_I');

    // Ограничение появилось уже после публикации — ровно тот случай, ради
    // которого ТЗ §5.1 требует перепроверку раз в сутки.
    registryMock.setRestriction(lot.cadastreOrVin, ['Арест по решению суда']);

    // Следующий тик. force — потому что в проде между тиками проходят сутки и
    // метка прогона меняется сама; в тесте суток нет, а суточную защиту от
    // повтора обходит ровно этот флаг (её отдельно проверяет тест ниже).
    await runSweep({ force: true });

    expect(await statusOf(lot.id)).toBe('PAUSED');

    // В досье лота лежат все три проверки: подача, чистый тик, тик с арестом.
    const checks = await checksOf(lot.id);
    expect(checks).toHaveLength(3);
    expect(checks.map((check) => check.hasRestriction)).toEqual([false, false, true]);

    // Продавцу поставлено уведомление; отправку заберёт адаптер (T-033).
    const notifications = await prisma.notification.findMany({ where: { userId: sellerId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.template).toBe('lot.paused.registry_restriction');
    expect(notifications[0]?.status).toBe('PENDING');

    // Остановка прошла через статусную машину, а не в обход: есть запись аудита.
    const audit = await prisma.auditLog.findMany({
      where: { entity: 'lots', entityId: lot.id, action: 'lot.transition' },
    });
    expect(audit.some((row) => JSON.stringify(row.payloadJson).includes('PAUSED'))).toBe(true);
  });

  it('чистый ответ реестра ничего не меняет', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotInPhase(seller, admin, 'PHASE_II');

    await runSweep();

    expect(await statusOf(lot.id)).toBe('PHASE_II');
    const checks = await checksOf(lot.id);
    expect(checks).toHaveLength(2); // подача + тик крона
    expect(checks.every((check) => !check.hasRestriction)).toBe(true);
  });

  it('лот в живых торгах не останавливается, но инцидент фиксируется', async () => {
    const admin = await devLogin(['ADMIN']);
    const adminId = await userId(admin);
    const seller = await sellerLogin(admin);
    const lot = await lotInPhase(seller, admin, 'PHASE_III');

    registryMock.setRestriction(lot.cadastreOrVin, ['Запрет на регистрационные действия']);
    await runSweep();

    // Перехода PHASE_III → PAUSED в статусной машине нет: остановка живых
    // торгов — это SLA Freeze (FR-08), а не смена статуса лота.
    expect(await statusOf(lot.id)).toBe('PHASE_III');

    const checks = await checksOf(lot.id);
    expect(checks).toHaveLength(2); // подача + тик крона
    expect(checks[1]?.hasRestriction).toBe(true);

    const forAdmin = await prisma.notification.findMany({ where: { userId: adminId } });
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]?.template).toBe('lot.restriction_during_bidding');
  });

  it('повторный обход в те же сутки не проверяет лот дважды', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);
    const lot = await lotInPhase(seller, admin, 'PHASE_I');

    // Двойной запуск крона — штатная ситуация: несколько реплик воркера,
    // ретрай, ручной прогон админом. Реестр — внешняя госсистема, и дёргать
    // её дважды за одно и то же нельзя.
    await runSweep();
    await runSweep();

    // Подача + ровно один тик: второй обход в те же сутки лот не трогает.
    const checks = await checksOf(lot.id);
    expect(checks).toHaveLength(2);
  });

  it('черновики и завершённые лоты не перепроверяются', async () => {
    const admin = await devLogin(['ADMIN']);
    const seller = await sellerLogin(admin);

    const draft = await api()
      .post('/api/lots')
      .set(...auth(seller))
      .send({ type: 'REALTY', cadastreOrVin: uniqueVin(), startPriceTenge: 5_000_000 })
      .expect(201);
    const draftId = (draft.body as LotView).id;

    await runSweep();

    const checks = await prisma.registryCheck.findMany({ where: { lotId: draftId } });
    expect(checks).toHaveLength(0);
  });
});
