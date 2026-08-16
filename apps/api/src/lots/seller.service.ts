import { toTenge, tiyn, type SellerDashboardView, type SellerLotView } from '@auction/shared';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { LotViewsService } from './lot-views.service';

/**
 * Монитор прозрачности продавца (T-041, FR-15).
 *
 * Показывает интерес к лоту цифрами: просмотры карточки, скачивания из Data
 * Room, записи на показ, принятые ставки. Смысл в том, чтобы продавец видел
 * это сам, а не со слов площадки, — поэтому цифры считаются из тех же таблиц,
 * что показываются участникам, без отдельного «витринного» счётчика.
 */
@Injectable()
export class SellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: LotViewsService,
  ) {}

  /** Все лоты продавца с метриками. Чужие лоты сюда не попадают по построению. */
  async dashboard(sellerId: string): Promise<SellerDashboardView> {
    const lots = await this.prisma.lot.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      include: {
        documents: { select: { downloadsCount: true } },
        openHouseSlots: { select: { _count: { select: { bookings: true } } } },
        _count: { select: { bids: true } },
      },
    });

    // Просмотры — вместе с ещё не сброшенными из Redis: продавец смотрит на
    // монитор именно во время наплыва, и «данные минутной давности» здесь
    // выглядят как остановившийся счётчик.
    const viewTotals = await this.views.withPending(
      lots.map((lot) => ({ id: lot.id, viewsCount: lot.viewsCount })),
    );

    const items: SellerLotView[] = lots.map((lot) => ({
      id: lot.id,
      type: lot.type,
      cadastreOrVin: lot.cadastreOrVin,
      status: lot.status,
      startPriceTenge: Number(toTenge(tiyn(lot.startPriceTiyn))),
      currentPriceTenge:
        lot.currentPriceTiyn === null ? null : Number(toTenge(tiyn(lot.currentPriceTiyn))),
      viewsCount: viewTotals.get(lot.id) ?? lot.viewsCount,
      documentsCount: lot.documents.length,
      downloadsCount: lot.documents.reduce((sum, document) => sum + document.downloadsCount, 0),
      openHouseSlots: lot.openHouseSlots.length,
      openHouseBookings: lot.openHouseSlots.reduce((sum, slot) => sum + slot._count.bookings, 0),
      bidsCount: lot._count.bids,
      createdAt: lot.createdAt.toISOString(),
      updatedAt: lot.updatedAt.toISOString(),
    }));

    return { items };
  }
}
