import { toTenge, tiyn } from '@auction/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { BANK_PROVIDER, type BankProvider } from '../integrations/bank/bank.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/** Счёт А — операционный счёт ТОО, из комиссии которого платится доля партнёра. */
const PLATFORM_ACCOUNT_IBAN = 'KZ00000000000000000001';
const KBE_LEGAL_ENTITY = '17';

/** Шаблон уведомления о поступлении денег партнёру. */
export const TEMPLATE_REF_BONUS_PAID = 'partner.ref_bonus_paid';

/**
 * Выплата Ref-Bonus партнёру (T-047, FR-19, ОВ-11).
 *
 * Платится ИЗ комиссии платформы, а не сверху: продавцу заявлен «сбор 0 %», и
 * второй комиссии взяться неоткуда. Поэтому выплата возможна только после
 * того, как комиссия действительно пришла — то есть после расщепления доплаты
 * победителя. Начислить бонус раньше можно (T-043), заплатить — нет: иначе
 * площадка платит из своего кармана за сделку, денег по которой не получила.
 */
@Injectable()
export class RefBonusPayoutService {
  private readonly logger = new Logger(RefBonusPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(BANK_PROVIDER) private readonly bank: BankProvider,
  ) {}

  /**
   * Выплатить начисленные бонусы по лотам, где комиссия уже собрана.
   *
   * Возвращает число выплаченных. Идемпотентно: перевод в PAID идёт условием
   * «был ACCRUED», и второй заход не найдёт работы. Повторная выплата — это
   * деньги, которые придётся истребовать обратно.
   */
  async payDue(limit = 50): Promise<number> {
    const due = await this.prisma.refBonus.findMany({
      where: {
        status: 'ACCRUED',
        // Комиссия собрана: доля платформы по этому лоту ушла поручением.
        lot: {
          payments: {
            some: { status: 'PAID', splits: { some: { kind: 'FEE_5PCT', status: 'SENT' } } },
          },
        },
      },
      select: { id: true, partnerId: true, lotId: true, amountTiyn: true },
      take: limit,
    });

    let paid = 0;
    for (const bonus of due) {
      if (await this.pay(bonus)) {
        paid += 1;
      }
    }
    if (paid > 0) {
      this.logger.log(`Выплачено долей партнёрам: ${String(paid)}`);
    }
    return paid;
  }

  private async pay(bonus: {
    id: string;
    partnerId: string;
    lotId: string;
    amountTiyn: bigint;
  }): Promise<boolean> {
    // Захват записи статусом: выиграет один заход, второй увидит ноль строк.
    const claimed = await this.prisma.refBonus.updateMany({
      where: { id: bonus.id, status: 'ACCRUED' },
      data: { status: 'PAID' },
    });
    if (claimed.count === 0) {
      return false;
    }

    try {
      await this.bank.split({
        reference: `refbonus-${bonus.id}`,
        parts: [
          {
            iban: PLATFORM_ACCOUNT_IBAN,
            kbe: KBE_LEGAL_ENTITY,
            amountTiyn: bonus.amountTiyn,
            purpose: `Вознаграждение партнёра 2 % по лоту ${bonus.lotId}`,
          },
        ],
      });
    } catch (error) {
      // Банк не принял поручение — возвращаем запись в начисленные, чтобы
      // следующий заход попробовал снова. Оставить её выплаченной значило бы
      // потерять чужие деньги молча.
      await this.prisma.refBonus.updateMany({
        where: { id: bonus.id, status: 'PAID' },
        data: { status: 'ACCRUED' },
      });
      this.logger.error(
        `Доля ${bonus.id}: поручение не ушло — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    await this.notifications.notify({
      userId: bonus.partnerId,
      template: TEMPLATE_REF_BONUS_PAID,
      priority: 'NORMAL',
      params: {
        lotId: bonus.lotId,
        amountTenge: String(toTenge(tiyn(bonus.amountTiyn))),
      },
    });
    return true;
  }
}
