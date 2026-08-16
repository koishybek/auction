import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { VetoActService } from '../documents/veto-act.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import { LotsService } from './lots.service';

/**
 * Срок Цифрового Карантина — 5 месяцев (ТЗ §4.2, FR-17).
 *
 * Календарные месяцы, а не 150 дней: «пять месяцев» в договоре означает ту же
 * дату через пять месяцев, и превращать их в фиксированное число суток —
 * значит спорить с юристом о трёх днях.
 */
export const LOCKOUT_MONTHS = 5;

export function lockoutUntil(fromMs: number): Date {
  const until = new Date(fromMs);
  until.setUTCMonth(until.getUTCMonth() + LOCKOUT_MONTHS);
  return until;
}

/**
 * Право ВЕТО и Цифровой Карантин (T-045, FR-17).
 *
 * После торгов продавец либо подтверждает сделку, либо отказывается. Отказ
 * бесплатен для него в моменте, но закрывает объект для площадки на пять
 * месяцев — иначе торги превращаются в бесплатную оценку: собрал цену,
 * отказался, выставил заново.
 */
@Injectable()
export class VetoService {
  private readonly logger = new Logger(VetoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lots: LotsService,
    private readonly acts: VetoActService,
    private readonly payments: PaymentsService,
    private readonly time: TimeService,
  ) {}

  /**
   * Подтвердить сделку: лот закрывается, победителю выставляется доплата.
   *
   * Доплата открывается именно здесь, а не сразу после торгов: пока продавец
   * не подтвердил сделку, он может её отклонить правом ВЕТО, и счёт,
   * выставленный заранее, пришлось бы отзывать (FR-17 → INT-03).
   */
  async confirm(
    lotId: string,
    sellerId: string,
  ): Promise<{ status: 'CLOSED'; paymentId: string | null }> {
    await this.requireOwnFinishedLot(lotId, sellerId);
    await this.lots.transition({ lotId, to: 'CLOSED', actor: 'SELLER', actorId: sellerId });

    const payment = await this.payments.openForWinner(lotId);
    return { status: 'CLOSED', paymentId: payment?.paymentId ?? null };
  }

  /**
   * Реализовать право ВЕТО.
   *
   * Порядок важен: сначала карантин и статус, потом акт. Документ описывает
   * уже принятое решение — собранный раньше, он описывал бы намерение, и при
   * сбое на середине остался бы акт по лоту, который никто не отклонял.
   */
  async veto(
    lotId: string,
    sellerId: string,
  ): Promise<{ status: 'VETOED'; lockoutUntil: string; actDocumentId: string }> {
    await this.requireOwnFinishedLot(lotId, sellerId);

    const until = lockoutUntil(this.time.wallClockMs());
    await this.lots.transition({ lotId, to: 'VETOED', actor: 'SELLER', actorId: sellerId });
    await this.prisma.lot.updateMany({ where: { id: lotId }, data: { lockoutUntil: until } });

    const actDocumentId = await this.acts.generate(lotId);
    this.logger.log(`Лот ${lotId}: ВЕТО продавца, карантин до ${until.toISOString()}`);

    return { status: 'VETOED', lockoutUntil: until.toISOString(), actDocumentId };
  }

  private async requireOwnFinishedLot(lotId: string, sellerId: string): Promise<void> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: lotId },
      select: { sellerId: true, status: true },
    });
    if (lot === null || lot.sellerId !== sellerId) {
      // Не «404 против 403»: чужой лот для продавца не существует.
      throw new ForbiddenException({ code: 'LOT_NOT_OWNED' });
    }
    if (lot.status !== 'FINISHED') {
      throw new ConflictException({ code: 'LOT_NOT_FINISHED' });
    }
  }
}
