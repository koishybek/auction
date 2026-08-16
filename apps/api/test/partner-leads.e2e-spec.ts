import type {
  EgovLoginResult,
  PartnerLeadView,
  PartnerLeadsView,
  TokenPair,
} from '@auction/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { LEAD_LOCK_MS, LeadsService } from '../src/partners/leads.service';
import { PrismaService } from '../src/prisma/prisma.service';

import { cleanDatabase } from './test-db';
import { listenForSupertest } from './test-http';

/**
 * Лиды партнёров (T-042, FR-18).
 *
 * DoD: повторная регистрация занятого объекта другим партнёром отклоняется,
 * а закрепление снимается на 91-й день. И то и другое — про деньги: из
 * закрепления растёт Ref-Bonus, и два партнёра на одном объекте означают спор
 * о комиссии.
 */

let app: INestApplication;
let prisma: PrismaService;
let leads: LeadsService;

function api(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

function randomIin(): string {
  return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

function randomCadastre(): string {
  return `20-317-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
}

/** Верифицированный партнёр: роль выдаёт админ, верификацию — eGov. */
async function partner(): Promise<string> {
  const init = await api().post('/api/auth/egov/init').expect(200);
  const sessionId = (init.body as { sessionId: string }).sessionId;
  await api()
    .post('/api/auth/egov/dev-approve')
    .send({ sessionId, iin: randomIin(), fio: 'Партнёр Тестович', biometricConfirmed: true })
    .expect(200);
  const done = await api().post('/api/auth/egov/complete').send({ sessionId }).expect(200);
  const result = done.body as EgovLoginResult;
  if (result.status !== 'COMPLETED') throw new Error('eGov-вход не завершился');

  const me = await api()
    .get('/api/auth/me')
    .set(...auth(result.tokens.accessToken))
    .expect(200);
  const admin = await api()
    .post('/api/auth/dev-login')
    .send({ roles: ['ADMIN'] })
    .expect(200);
  await api()
    .patch(`/api/admin/users/${(me.body as { id: string }).id}/roles`)
    .set(...auth((admin.body as TokenPair).accessToken))
    .send({ roles: ['PARTNER'], reason: 'выдача роли партнёра в тесте' })
    .expect(200);

  return result.tokens.accessToken;
}

async function registerLead(
  token: string,
  cadastreOrVin: string,
): Promise<{ status: number; body: unknown }> {
  const response = await api()
    .post('/api/partner/leads')
    .set(...auth(token))
    .send({ ownerIin: randomIin(), ownerPhone: '+77011234567', cadastreOrVin });
  return { status: response.status, body: response.body };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.init();
  await listenForSupertest(app);

  prisma = app.get(PrismaService);
  leads = app.get(LeadsService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDatabase(prisma);
});

describe('T-042: лиды партнёра', () => {
  it('регистрация закрепляет объект на 90 дней', async () => {
    const token = await partner();
    const cadastre = randomCadastre();

    const created = await registerLead(token, cadastre);
    expect(created.status).toBe(201);

    const lead = created.body as PartnerLeadView;
    expect(lead.status).toBe('LOCKED');
    expect(lead.cadastreOrVin).toBe(cadastre);
    expect(lead.lockRemainingMs).toBeGreaterThan(LEAD_LOCK_MS - 60_000);
    expect(lead.lockRemainingMs).toBeLessThanOrEqual(LEAD_LOCK_MS);
  });

  it('DoD: занятый объект другому партнёру не достаётся', async () => {
    const first = await partner();
    const second = await partner();
    const cadastre = randomCadastre();

    expect((await registerLead(first, cadastre)).status).toBe(201);

    const taken = await registerLead(second, cadastre);
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'TAKEN' });

    // Чужой лид не появился даже как запись: закрепление одно на объект.
    expect(await prisma.partnerLead.count({ where: { cadastreOrVin: cadastre } })).toBe(1);
  });

  it('повтор тем же партнёром не плодит лидов', async () => {
    const token = await partner();
    const cadastre = randomCadastre();

    const first = await registerLead(token, cadastre);
    const second = await registerLead(token, cadastre);

    expect(second.status).toBe(201);
    expect((second.body as PartnerLeadView).id).toBe((first.body as PartnerLeadView).id);
    expect(await prisma.partnerLead.count({ where: { cadastreOrVin: cadastre } })).toBe(1);
  });

  it('DoD: на 91-й день закрепление снимается и объект свободен', async () => {
    const first = await partner();
    const second = await partner();
    const cadastre = randomCadastre();

    const created = await registerLead(first, cadastre);
    const leadId = (created.body as PartnerLeadView).id;

    // Отматываем срок на день назад — ждать девяносто суток нечестно и незачем.
    await prisma.partnerLead.update({
      where: { id: leadId },
      data: { lockedUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    expect(await leads.releaseExpired()).toBe(1);
    const stored = await prisma.partnerLead.findUniqueOrThrow({ where: { id: leadId } });
    expect(stored.status).toBe('EXPIRED');

    // Объект освободился — его берёт другой партнёр.
    expect((await registerLead(second, cadastre)).status).toBe(201);
  });

  it('объект, уже торгующийся на площадке, лидом не закрепить', async () => {
    const token = await partner();
    const seller = await prisma.user.create({ data: { roles: ['SELLER'] }, select: { id: true } });
    const cadastre = randomCadastre();
    await prisma.lot.create({
      data: {
        sellerId: seller.id,
        type: 'REALTY',
        cadastreOrVin: cadastre,
        startPriceTiyn: 1_000_000_00n,
        status: 'PHASE_II',
      },
    });

    // Собственник пришёл сам — приводить его партнёру не за что.
    const rejected = await registerLead(token, cadastre);
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ code: 'ALREADY_ON_PLATFORM' });
  });

  it('контакты собственника не возвращаются наружу и лежат зашифрованными', async () => {
    const token = await partner();
    const cadastre = randomCadastre();
    const ownerIin = randomIin();

    await api()
      .post('/api/partner/leads')
      .set(...auth(token))
      .send({ ownerIin, ownerPhone: '+77015557788', cadastreOrVin: cadastre })
      .expect(201);

    const list = await api()
      .get('/api/partner/leads')
      .set(...auth(token))
      .expect(200);

    // Ни в одном ответе кабинета контактов собственника нет (FR-09).
    expect(JSON.stringify(list.body)).not.toContain(ownerIin);
    expect(JSON.stringify(list.body)).not.toContain('7788');
    expect((list.body as PartnerLeadsView).items).toHaveLength(1);

    const stored = await prisma.partnerLead.findFirstOrThrow({
      where: { cadastreOrVin: cadastre },
    });
    expect(Buffer.from(stored.ownerContactEnc).toString('utf8')).not.toContain(ownerIin);
  });

  it('чужие лиды в кабинете не видны', async () => {
    const first = await partner();
    const second = await partner();
    await registerLead(first, randomCadastre());

    const list = await api()
      .get('/api/partner/leads')
      .set(...auth(second))
      .expect(200);
    expect((list.body as PartnerLeadsView).items).toHaveLength(0);
  });

  it('без роли партнёра кабинет закрыт', async () => {
    const investor = await api()
      .post('/api/auth/dev-login')
      .send({ roles: ['INVESTOR'] })
      .expect(200);

    await api()
      .get('/api/partner/leads')
      .set(...auth((investor.body as TokenPair).accessToken))
      .expect(403);
  });
});
