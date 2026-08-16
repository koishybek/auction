import type { PartnerLeadView, PartnerLeadsView } from '@auction/shared';
import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

/**
 * Срок закрепления лида за партнёром — 90 дней (FR-18).
 *
 * Календарные, не банковские: ТЗ говорит «90 дней», и превращать их в рабочие
 * значило бы додумывать за заказчика в его пользу или против.
 */
export const LEAD_LOCK_MS = 90 * 24 * 60 * 60 * 1000;

/** Статусы лота, при которых объект считается уже работающим на площадке. */
const OCCUPIED_LOT_STATUSES = [
  'MODERATION',
  'PHASE_I',
  'PHASE_II',
  'PHASE_III',
  'FINISHED',
] as const;

/**
 * Лиды партнёров (T-042, FR-18).
 *
 * Партнёр приводит собственника и закрепляет объект за собой на 90 дней; из
 * этого закрепления потом растёт Ref-Bonus (FR-19). Поэтому «занят или нет» —
 * это вопрос о деньгах, а не о вежливости, и отвечает на него уникальный
 * индекс в базе, а не проверка в коде: между проверкой и записью помещаются
 * два партнёра.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCryptoService,
    private readonly time: TimeService,
  ) {}

  /**
   * Зарегистрировать лид и закрепить объект.
   *
   * Повтор тем же партнёром возвращает его же лид: человек мог обновить
   * страницу, и второе закрепление того же объекта за тем же партнёром — не
   * ошибка, а то же самое действие.
   */
  async register(input: {
    partnerId: string;
    cadastreOrVin: string;
    ownerIin: string;
    ownerPhone: string;
  }): Promise<PartnerLeadView> {
    const now = this.time.wallClockMs();
    await this.releaseExpired();

    const onPlatform = await this.prisma.lot.findFirst({
      where: { cadastreOrVin: input.cadastreOrVin, status: { in: [...OCCUPIED_LOT_STATUSES] } },
      select: { id: true },
    });
    if (onPlatform !== null) {
      // Объект уже продаётся: приводить собственника, который пришёл сам,
      // партнёру не за что.
      throw new ConflictException({ code: 'ALREADY_ON_PLATFORM' });
    }

    const active = await this.prisma.partnerLead.findFirst({
      where: { cadastreOrVin: input.cadastreOrVin, status: 'LOCKED' },
    });
    if (active !== null) {
      if (active.partnerId === input.partnerId) {
        return this.toView(active, now);
      }
      throw new ConflictException({ code: 'TAKEN' });
    }

    // Контакты собственника — ПДн: в базу только шифротекстом, привязанным к
    // своей колонке (CLAUDE.md §4.5).
    const ownerContactEnc = this.pii.encrypt(
      JSON.stringify({ iin: input.ownerIin, phone: input.ownerPhone }),
      'partner_leads.owner_contact',
    );

    try {
      const lead = await this.prisma.partnerLead.create({
        data: {
          partnerId: input.partnerId,
          cadastreOrVin: input.cadastreOrVin,
          ownerContactEnc,
          status: 'LOCKED',
          lockedUntil: new Date(now + LEAD_LOCK_MS),
        },
      });
      this.logger.log(`Лид ${lead.id}: объект ${input.cadastreOrVin} закреплён на 90 дней`);
      return this.toView(lead, now);
    } catch (error) {
      // Гонка двух партнёров: индекс пропустил только одного. Второй получает
      // тот же отказ, что и при обычной занятости.
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'TAKEN' });
      }
      throw error;
    }
  }

  /**
   * Связать лид с появившимся лотом (FR-18 → FR-19).
   *
   * Без этой связи закрепление остаётся бумажкой: доля партнёра считается от
   * победной цены ЕГО лота, и «его» определяется именно здесь. Совпадение по
   * кадастру/VIN — единственное, что связывает приведённого собственника с
   * выставленным объектом: партнёр лот не создаёт, его создаёт продавец.
   *
   * Возвращает id лида или `null`, если объект приводил никто.
   */
  async attachLot(cadastreOrVin: string, lotId: string): Promise<string | null> {
    const lead = await this.prisma.partnerLead.findFirst({
      where: { cadastreOrVin, status: 'LOCKED' },
      select: { id: true },
    });
    if (lead === null) {
      return null;
    }

    // Закрепление больше не нужно: объект дошёл до площадки, и держать его от
    // других партнёров незачем — он уже не свободен по другой причине.
    await this.prisma.partnerLead.updateMany({
      where: { id: lead.id, status: 'LOCKED' },
      data: { status: 'CONVERTED', lotId },
    });
    this.logger.log(`Лид ${lead.id}: объект вышел на площадку лотом ${lotId}`);
    return lead.id;
  }

  /** Лиды партнёра. Чужих здесь нет по построению выборки. */
  async list(partnerId: string): Promise<PartnerLeadsView> {
    await this.releaseExpired();
    const now = this.time.wallClockMs();

    const leads = await this.prisma.partnerLead.findMany({
      where: { partnerId },
      orderBy: { createdAt: 'desc' },
      include: { lot: { select: { id: true, status: true } } },
    });
    return { items: leads.map((lead) => this.toView(lead, now)) };
  }

  /**
   * Снять закрепления, у которых вышел срок.
   *
   * Вызывается и воркером, и на входе в кабинет: партнёр не должен видеть
   * «закреплён» у лида, срок которого истёк вчера, только потому, что воркер
   * ещё не дошёл. Идемпотентно — обновляются только строки в LOCKED.
   */
  async releaseExpired(): Promise<number> {
    const result = await this.prisma.partnerLead.updateMany({
      where: { status: 'LOCKED', lockedUntil: { lt: new Date(this.time.wallClockMs()) } },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log(`Снято закреплений по сроку: ${String(result.count)}`);
    }
    return result.count;
  }

  private toView(
    lead: {
      id: string;
      cadastreOrVin: string;
      status: string;
      lockedUntil: Date | null;
      lotId: string | null;
      createdAt: Date;
      lot?: { id: string; status: string } | null;
    },
    nowMs: number,
  ): PartnerLeadView {
    const remaining =
      lead.status === 'LOCKED' && lead.lockedUntil !== null
        ? Math.max(0, lead.lockedUntil.getTime() - nowMs)
        : null;

    return {
      id: lead.id,
      cadastreOrVin: lead.cadastreOrVin,
      status: lead.status as PartnerLeadView['status'],
      lockRemainingMs: remaining,
      lotId: lead.lotId,
      lotStatus: (lead.lot?.status ?? null) as PartnerLeadView['lotStatus'],
      createdAt: lead.createdAt.toISOString(),
    };
  }
}

/** Нарушение уникального индекса в Prisma. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
