import { toTenge, tiyn, type RefBonusView, type RefBonusesView } from '@auction/shared';
import { Injectable, Logger } from '@nestjs/common';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Доля партнёра — 2 % от победной цены (FR-19, ОВ-11).
 *
 * Платятся из комиссии платформы (5 %), а не сверху: продавцу «Сбор заявки
 * 0 %», и вторая комиссия ниоткуда взяться не может.
 */
const REF_BONUS_PERCENT = 2n;

/**
 * Округление доли — банковское, до целого тенге.
 *
 * То же правило, что у шага цены: проценты в этой системе всегда превращаются
 * в деньги одинаково, иначе в отчётах появляются две разные арифметики. Считаем
 * в целых числах — множитель 0.02 не представим двоичной дробью точно.
 */
export function refBonusTiyn(priceTiyn: bigint): bigint {
  const tenge = priceTiyn / 100n;
  const scaled = tenge * REF_BONUS_PERCENT;
  let quotient = scaled / 100n;
  const remainder = scaled - quotient * 100n;

  if (remainder > 50n || (remainder === 50n && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return quotient * 100n;
}

/**
 * Ref-Bonus партнёра (T-043, FR-19).
 *
 * Пока торги идут, доля — прогноз: она пересчитывается от текущей цены при
 * каждом запросе и нигде не хранится. Хранить прогноз значило бы держать
 * число, которое устаревает каждую ставку, и однажды показать партнёру не ту
 * сумму. Запись появляется в момент закрытия торгов — когда цена перестала
 * меняться и доля стала фактом.
 */
@Injectable()
export class RefBonusService {
  private readonly logger = new Logger(RefBonusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Прогноз и начисленное по всем лотам партнёра. */
  async list(partnerId: string): Promise<RefBonusesView> {
    const [accrued, liveLeads] = await Promise.all([
      this.prisma.refBonus.findMany({
        where: { partnerId },
        include: { lot: { select: { cadastreOrVin: true, status: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      // Лоты, которые ещё торгуются: по ним доля пока только прогноз.
      this.prisma.partnerLead.findMany({
        where: {
          partnerId,
          lotId: { not: null },
          lot: { status: { in: ['PHASE_II', 'PHASE_III'] } },
        },
        include: {
          lot: {
            select: {
              id: true,
              cadastreOrVin: true,
              status: true,
              startPriceTiyn: true,
              currentPriceTiyn: true,
            },
          },
        },
      }),
    ]);

    const items: RefBonusView[] = accrued.map((bonus) => ({
      lotId: bonus.lotId,
      cadastreOrVin: bonus.lot.cadastreOrVin,
      lotStatus: bonus.lot.status,
      amountTenge: Number(toTenge(tiyn(bonus.amountTiyn))),
      status: bonus.status,
      updatedAt: bonus.updatedAt.toISOString(),
    }));

    const accruedLots = new Set(items.map((item) => item.lotId));
    for (const lead of liveLeads) {
      const lot = lead.lot;
      if (lot === null || accruedLots.has(lot.id)) {
        continue;
      }
      const priceTiyn = await this.livePriceTiyn(lot.id, lot.startPriceTiyn);
      items.push({
        lotId: lot.id,
        cadastreOrVin: lot.cadastreOrVin,
        lotStatus: lot.status,
        // Считается прямо сейчас, от текущей цены: прогноз обязан идти за
        // ценой, а не отставать на один сброшенный кэш.
        amountTenge: Number(toTenge(tiyn(refBonusTiyn(priceTiyn)))),
        status: 'FORECAST',
        updatedAt: new Date().toISOString(),
      });
    }

    return { items };
  }

  /**
   * Цена лота прямо сейчас — по последней записанной ставке.
   *
   * Не из колонки лота: она обновляется только при закрытии торгов, и прогноз
   * стоял бы на стартовой цене всю сессию. И не из Redis: живое состояние
   * принадлежит движку торгов, а партнёрский кабинет о нём знать не должен
   * (CLAUDE.md, раздел 3). Ставки доезжают в PostgreSQL за доли секунды —
   * для прогноза комиссии этого отставания не существует.
   */
  private async livePriceTiyn(lotId: string, startPriceTiyn: bigint): Promise<bigint> {
    const last = await this.prisma.bid.findFirst({
      where: { lotId },
      orderBy: { seq: 'desc' },
      select: { amountTiyn: true },
    });
    return last?.amountTiyn ?? startPriceTiyn;
  }

  /**
   * Зафиксировать долю партнёра после закрытия торгов.
   *
   * Идемпотентно: повторный вызов не создаёт второй записи — на пару
   * «партнёр + лот» бонус один, и это ограничение базы, а не соглашение.
   * Партнёра ищем по лиду: связь «кто привёл объект» живёт там.
   */
  async accrue(lotId: string, finalPriceTiyn: bigint): Promise<RefBonusView | null> {
    const lead = await this.prisma.partnerLead.findFirst({
      where: { lotId },
      select: { partnerId: true },
    });
    if (lead === null) {
      // Лот пришёл без партнёра — делить не с кем.
      return null;
    }

    const amountTiyn = refBonusTiyn(finalPriceTiyn);
    const bonus = await this.prisma.refBonus.upsert({
      where: { partnerId_lotId: { partnerId: lead.partnerId, lotId } },
      create: { partnerId: lead.partnerId, lotId, amountTiyn, status: 'ACCRUED' },
      update: { amountTiyn, status: 'ACCRUED' },
      include: { lot: { select: { cadastreOrVin: true, status: true } } },
    });

    // Уведомление о поступлении — часть FR-19: партнёр не должен узнавать о
    // своих деньгах, заглянув в кабинет.
    await this.notifications.notify({
      userId: lead.partnerId,
      template: TEMPLATE_REF_BONUS,
      priority: 'NORMAL',
      params: { lotId, amountTenge: String(toTenge(tiyn(amountTiyn))) },
    });

    this.logger.log(
      `Лот ${lotId}: партнёру начислено ${String(amountTiyn / 100n)} ₸ (2 % от победной цены)`,
    );

    return {
      lotId,
      cadastreOrVin: bonus.lot.cadastreOrVin,
      lotStatus: bonus.lot.status,
      amountTenge: Number(toTenge(tiyn(bonus.amountTiyn))),
      status: bonus.status,
      updatedAt: bonus.updatedAt.toISOString(),
    };
  }
}

/** Шаблон уведомления о начислении доли. */
export const TEMPLATE_REF_BONUS = 'partner.ref_bonus_accrued';
