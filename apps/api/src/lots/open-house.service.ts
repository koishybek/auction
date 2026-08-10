import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

export interface OpenHouseSlotView {
  readonly id: string;
  readonly lotId: string;
  readonly slotAt: string;
  readonly bookedCount: number;
  readonly bookedByMe: boolean;
}

/** Окно Open House — 5 дней (ТЗ §4.2). */
const OPEN_HOUSE_WINDOW_DAYS = 5;
const MAX_SLOTS = 40;

@Injectable()
export class OpenHouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  /**
   * Продавец назначает слоты показов своего лота.
   *
   * Слоты обязаны попадать в окно 5 дней от «сейчас» и лежать в будущем:
   * показ задним числом — бессмыслица, а показ через месяц ломает регламент
   * фазы II. Дубли по времени схлопывает уникальный констрейнт (lot_id, slot_at).
   */
  async createSlots(input: {
    lotId: string;
    seller: AuthenticatedUser;
    slotsAt: readonly string[];
  }): Promise<readonly OpenHouseSlotView[]> {
    const lot = await this.prisma.lot.findUnique({ where: { id: input.lotId } });
    if (!lot) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }
    if (lot.sellerId !== input.seller.id) {
      throw new ForbiddenException({ code: 'NOT_LOT_OWNER' });
    }

    const now = this.time.wallClockMs();
    const windowEnd = now + OPEN_HOUSE_WINDOW_DAYS * 86_400_000;

    const parsed = input.slotsAt.map((raw) => {
      const ts = Date.parse(raw);
      if (Number.isNaN(ts)) {
        throw new BadRequestException({ code: 'BAD_SLOT_TIME', message: `Не время: ${raw}` });
      }
      if (ts <= now) {
        throw new BadRequestException({
          code: 'SLOT_IN_PAST',
          message: 'Слот показа должен быть в будущем',
        });
      }
      if (ts > windowEnd) {
        throw new BadRequestException({
          code: 'SLOT_OUT_OF_WINDOW',
          message: `Показы назначаются в пределах ${String(OPEN_HOUSE_WINDOW_DAYS)} дней`,
        });
      }
      return new Date(ts);
    });

    const existing = await this.prisma.openHouseSlot.count({ where: { lotId: lot.id } });
    if (existing + parsed.length > MAX_SLOTS) {
      throw new BadRequestException({
        code: 'TOO_MANY_SLOTS',
        message: `Не больше ${String(MAX_SLOTS)} слотов на лот`,
      });
    }

    // skipDuplicates: повторная отправка того же расписания не падает и не дублирует.
    await this.prisma.openHouseSlot.createMany({
      data: parsed.map((slotAt) => ({ lotId: lot.id, slotAt })),
      skipDuplicates: true,
    });

    return this.listSlots(lot.id, input.seller);
  }

  /** График слотов лота. Виден всем, у кого есть доступ к лоту. */
  async listSlots(
    lotId: string,
    viewer: AuthenticatedUser | null,
  ): Promise<readonly OpenHouseSlotView[]> {
    const slots = await this.prisma.openHouseSlot.findMany({
      where: { lotId },
      orderBy: { slotAt: 'asc' },
      include: { bookings: { select: { userId: true } } },
    });

    return slots.map((slot) => ({
      id: slot.id,
      lotId: slot.lotId,
      slotAt: slot.slotAt.toISOString(),
      bookedCount: slot.bookings.length,
      bookedByMe: viewer !== null && slot.bookings.some((booking) => booking.userId === viewer.id),
    }));
  }

  /**
   * Запись на показ. Двойная запись одного человека в один слот невозможна —
   * это уникальный констрейнт (slot_id, user_id) в БД, а не проверка кодом:
   * два параллельных запроса не обойдут его при любом интерливинге (DoD T-018).
   */
  async book(slotId: string, viewer: AuthenticatedUser): Promise<OpenHouseSlotView> {
    const slot = await this.prisma.openHouseSlot.findUnique({
      where: { id: slotId },
      include: { lot: { select: { sellerId: true } } },
    });
    if (!slot) {
      throw new NotFoundException({ code: 'SLOT_NOT_FOUND' });
    }
    if (slot.lot.sellerId === viewer.id) {
      throw new ConflictException({
        code: 'OWN_LOT_BOOKING',
        message: 'Продавец не записывается на показ собственного лота',
      });
    }
    if (slot.slotAt.getTime() <= this.time.wallClockMs()) {
      throw new ConflictException({ code: 'SLOT_IN_PAST', message: 'Слот уже прошёл' });
    }

    try {
      await this.prisma.openHouseBooking.create({
        data: { slotId, userId: viewer.id },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'ALREADY_BOOKED',
          message: 'Вы уже записаны на этот слот',
        });
      }
      throw error;
    }

    const fresh = await this.listSlots(slot.lotId, viewer);
    const view = fresh.find((candidate) => candidate.id === slotId);
    if (!view) {
      throw new NotFoundException({ code: 'SLOT_NOT_FOUND' });
    }
    return view;
  }

  /** Отмена своей записи. Чужую отменить нельзя по построению: ключ — (slotId, userId). */
  async cancel(slotId: string, viewer: AuthenticatedUser): Promise<void> {
    const result = await this.prisma.openHouseBooking.deleteMany({
      where: { slotId, userId: viewer.id },
    });
    if (result.count === 0) {
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND' });
    }
  }
}

/** Код P2002 — нарушение уникальности в Prisma. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
