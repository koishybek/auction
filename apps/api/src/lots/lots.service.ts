import {
  PUBLIC_LOT_STATUSES,
  fromTenge,
  tiyn,
  toTenge,
  type LotListView,
  type LotStatusValue,
  type LotView,
} from '@auction/shared';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import type { Lot } from '../generated/prisma/client';
import type { LotStatus } from '../generated/prisma/enums';
import { REGISTRY_PROVIDER, type RegistryProvider } from '../integrations/registry/registry.types';
import { LeadsService } from '../partners/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import { LotViewsService, type ViewerIdentity } from './lot-views.service';
import {
  checkTransition,
  transitionDescription,
  type LotTransitionActor,
} from './lot-status.machine';

/**
 * Сущность Prisma → DTO на провод. Тиыны → тенге ровно здесь, на границе.
 *
 * `viewsCount` передаётся отдельным аргументом, а не берётся из строки лота:
 * решение «показывать ли эту цифру» принимает вызывающий, который знает, кто
 * смотрит. Значение по умолчанию — null, то есть «не показывать»: забытый
 * вызов молча скроет цифру, а не покажет лишнее.
 */
function toView(lot: Lot, viewsCount: number | null = null): LotView {
  return {
    id: lot.id,
    type: lot.type,
    cadastreOrVin: lot.cadastreOrVin,
    status: lot.status,
    title: lot.title,
    address: lot.address,
    description: lot.description,
    areaSqmX100: lot.areaSqmX100,
    mileageKm: lot.mileageKm,
    buildYear: lot.buildYear,
    startPriceTenge: Number(toTenge(tiyn(lot.startPriceTiyn))),
    currentPriceTenge:
      lot.currentPriceTiyn === null ? null : Number(toTenge(tiyn(lot.currentPriceTiyn))),
    sellerId: lot.sellerId,
    viewsCount,
    createdAt: lot.createdAt.toISOString(),
    updatedAt: lot.updatedAt.toISOString(),
  };
}

@Injectable()
export class LotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly pii: PiiCryptoService,
    private readonly views: LotViewsService,
    private readonly leads: LeadsService,
    @Inject(REGISTRY_PROVIDER) private readonly registry: RegistryProvider,
  ) {}

  /** Черновик создаёт продавец. Деньги приходят в тенге, хранятся в тиынах. */
  async createDraft(input: {
    sellerId: string;
    type: 'REALTY' | 'VEHICLE';
    cadastreOrVin: string;
    startPriceTenge: number;
    /**
     * Витрина. Необязательна: лот заводят раньше, чем собраны материалы.
     *
     * `| undefined` явно — при `exactOptionalPropertyTypes` «поля нет» и «поле
     * есть со значением undefined» это разные типы, а из Zod-схемы приходит
     * второе.
     */
    title?: string | undefined;
    address?: string | undefined;
    description?: string | undefined;
    areaSqmX100?: number | undefined;
    mileageKm?: number | undefined;
    buildYear?: number | undefined;
  }): Promise<LotView> {
    const cadastreOrVin = input.cadastreOrVin.trim().toUpperCase();

    /**
     * Цифровой Карантин: объект, по которому продавец реализовал право ВЕТО,
     * закрыт для площадки на пять месяцев (FR-17).
     *
     * Проверка стоит здесь, при создании, а не при выходе в торги: смысл
     * карантина в том, чтобы торги не превращались в бесплатную оценку —
     * собрал цену, отказался, выставил заново. Заводить черновик, который
     * заведомо никуда не пойдёт, тоже незачем.
     */
    const quarantined = await this.quarantineUntil(cadastreOrVin);
    if (quarantined !== null) {
      throw new ConflictException({
        code: 'OBJECT_IN_QUARANTINE',
        message: `Объект под Цифровым Карантином до ${quarantined.toISOString()}`,
      });
    }

    const lot = await this.prisma.lot.create({
      data: {
        sellerId: input.sellerId,
        type: input.type,
        cadastreOrVin,
        startPriceTiyn: fromTenge(BigInt(input.startPriceTenge)),
        // Пустое поле остаётся пустым, а не превращается в пустую строку:
        // «не заполнено» и «заполнено ничем» в карточке выглядят по-разному.
        title: input.title ?? null,
        address: input.address ?? null,
        description: input.description ?? null,
        areaSqmX100: input.areaSqmX100 ?? null,
        mileageKm: input.mileageKm ?? null,
        buildYear: input.buildYear ?? null,
      },
    });

    // Если объект приводил партнёр, лот привязывается к его лиду: от этой
    // связи считается его доля после торгов (FR-18 → FR-19). Партнёр лот не
    // создаёт — создаёт продавец, и совпадение по кадастру/VIN здесь
    // единственное, что их связывает.
    await this.leads.attachLot(lot.cadastreOrVin, lot.id);

    // Пишущие ручки доступны только владельцу и админу — им цифра положена.
    return toView(lot, lot.viewsCount);
  }

  /**
   * До какого момента объект под Цифровым Карантином. `null` — свободен.
   *
   * Проверяется по метке времени, а не по флагу, который снимал бы воркер.
   * Флаг был бы вторым источником правды об одном факте: не сработал воркер —
   * и объект остаётся закрытым после срока либо открывается раньше. Метка не
   * может разойтись сама с собой.
   */
  async quarantineUntil(cadastreOrVin: string): Promise<Date | null> {
    const vetoed = await this.prisma.lot.findFirst({
      where: {
        cadastreOrVin,
        status: 'VETOED',
        lockoutUntil: { gt: new Date(this.time.wallClockMs()) },
      },
      select: { lockoutUntil: true },
      orderBy: { lockoutUntil: 'desc' },
    });
    return vetoed?.lockoutUntil ?? null;
  }

  /** Правка только собственного ЧЕРНОВИКА: после модерации параметры заморожены. */
  async updateDraft(input: {
    lotId: string;
    sellerId: string;
    cadastreOrVin?: string | undefined;
    startPriceTenge?: number | undefined;
    title?: string | undefined;
    address?: string | undefined;
    description?: string | undefined;
    areaSqmX100?: number | undefined;
    mileageKm?: number | undefined;
    buildYear?: number | undefined;
  }): Promise<LotView> {
    const lot = await this.requireOwnLot(input.lotId, input.sellerId);
    if (lot.status !== 'DRAFT') {
      throw new ConflictException({
        code: 'LOT_NOT_EDITABLE',
        message: 'Править можно только черновик — после модерации параметры лота заморожены',
      });
    }

    const updated = await this.prisma.lot.update({
      where: { id: lot.id },
      data: {
        ...(input.cadastreOrVin === undefined
          ? {}
          : { cadastreOrVin: input.cadastreOrVin.trim().toUpperCase() }),
        ...(input.startPriceTenge === undefined
          ? {}
          : { startPriceTiyn: fromTenge(BigInt(input.startPriceTenge)) }),
        // Витрина правится по одному полю: не присланное остаётся как было, а
        // не затирается. Иначе правка цены стирала бы описание.
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.address === undefined ? {} : { address: input.address }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.areaSqmX100 === undefined ? {} : { areaSqmX100: input.areaSqmX100 }),
        ...(input.mileageKm === undefined ? {} : { mileageKm: input.mileageKm }),
        ...(input.buildYear === undefined ? {} : { buildYear: input.buildYear }),
      },
    });
    return toView(updated, updated.viewsCount);
  }

  /**
   * Карточка лота. Публичные статусы видны всем (каталог), черновики и
   * модерация — только владельцу и админу: чужая незавершённая заявка —
   * не публичная информация.
   */
  async getById(lotId: string, viewer: AuthenticatedUser | null): Promise<LotView> {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }

    const isPublic = (PUBLIC_LOT_STATUSES as readonly string[]).includes(lot.status);
    const isOwner = viewer !== null && viewer.id === lot.sellerId;
    const isAdmin = viewer !== null && viewer.roles.includes('ADMIN');
    if (!isPublic && !isOwner && !isAdmin) {
      // 404, а не 403: не подтверждаем сам факт существования чужого черновика.
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }

    if (!isOwner && !isAdmin) {
      return toView(lot);
    }
    const totals = await this.views.withPending([lot]);
    return toView(lot, totals.get(lot.id) ?? lot.viewsCount);
  }

  /**
   * Засчитать просмотр карточки.
   *
   * Видимость проверяется той же логикой, что и чтение: накрутить счётчик
   * чужому черновику нельзя, потому что его и увидеть нельзя.
   *
   * Собственные заходы продавца не считаются: цифра нужна ему как мера чужого
   * интереса, а не как счётчик своих обновлений страницы.
   */
  async recordView(
    lotId: string,
    viewer: AuthenticatedUser | null,
    client: ViewerIdentity,
  ): Promise<{ readonly counted: boolean }> {
    const lot = await this.getById(lotId, viewer);
    if (viewer !== null && viewer.id === lot.sellerId) {
      return { counted: false };
    }
    return { counted: await this.views.record(lot.id, client) };
  }

  /** Публичный каталог: только публичные статусы, свежие сверху. */
  async listPublic(input: {
    page: number;
    pageSize: number;
    type?: 'REALTY' | 'VEHICLE' | undefined;
    status?: LotStatusValue | undefined;
  }): Promise<LotListView> {
    const statusFilter =
      input.status !== undefined &&
      (PUBLIC_LOT_STATUSES as readonly string[]).includes(input.status)
        ? [input.status]
        : (PUBLIC_LOT_STATUSES as readonly LotStatus[]);

    const where = {
      status: { in: [...statusFilter] },
      ...(input.type === undefined ? {} : { type: input.type }),
    };

    const [lots, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.prisma.lot.count({ where }),
    ]);

    // Стрелка обязательна: map передаёт вторым аргументом индекс, и он приехал
    // бы в viewsCount — первый лот каталога показал бы посторонним «0 просмотров».
    return {
      items: lots.map((lot) => toView(lot)),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  /** Лоты продавца — все статусы, включая черновики, и просмотры по каждому. */
  async listMine(sellerId: string, page: number, pageSize: number): Promise<LotListView> {
    const where = { sellerId };
    const [lots, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lot.count({ where }),
    ]);

    const totals = await this.views.withPending(lots);
    return {
      items: lots.map((lot) => toView(lot, totals.get(lot.id) ?? lot.viewsCount)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Продавец отправляет черновик на модерацию.
   *
   * Здесь происходит проверка КИСИП/ЕРД (INT-02, T-019): по ИИН продавца и
   * кадастру/VIN объекта. ТЗ говорит «при создании лота» — трактуем как момент
   * подачи на платформу: черновик у себя человек может держать любой, а вот
   * заявка с арестованным объектом не должна дойти даже до модератора.
   *
   * Ограничение найдено → лот остаётся в DRAFT, продавцу — 409 с причинами.
   * Каждая проверка, включая чистую, пишется в registry_checks: история
   * проверок — часть досье лота.
   */
  async submit(lotId: string, seller: AuthenticatedUser): Promise<LotView> {
    const lot = await this.requireOwnLot(lotId, seller.id);
    if (lot.status !== 'DRAFT') {
      // Ранний отказ до похода в реестр: сам переход всё равно невозможен.
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Переход ${lot.status} → MODERATION не существует`,
      });
    }

    // Реестр проверяет по ИИН собственника — без верификации проверять нечем.
    if (!seller.egovVerified) {
      throw new ForbiddenException({ code: 'EGOV_NOT_VERIFIED' });
    }
    const sellerRow = await this.prisma.user.findUniqueOrThrow({ where: { id: seller.id } });
    if (sellerRow.iinEnc === null) {
      throw new ForbiddenException({ code: 'EGOV_NOT_VERIFIED' });
    }
    const iin = this.pii.decrypt(sellerRow.iinEnc, 'users.iin');

    const result = await this.registry.check({ iinOrBin: iin, cadastreOrVin: lot.cadastreOrVin });

    await this.prisma.registryCheck.create({
      data: {
        lotId: lot.id,
        hasRestriction: result.hasRestriction,
        payloadJson: result.payload,
        checkedAt: new Date(this.time.wallClockMs()),
      },
    });

    if (result.hasRestriction) {
      throw new ConflictException({
        code: 'REGISTRY_RESTRICTION',
        message: `Публикация невозможна: ${result.restrictions.join('; ')}`,
      });
    }

    return this.transition({ lotId, to: 'MODERATION', actor: 'SELLER', actorId: seller.id });
  }

  /**
   * Единственная точка смены статуса. Правомерность решает таблица переходов,
   * не вызывающий код. Недопустимый переход = 409 (DoD T-015).
   *
   * Обновление идёт через updateMany со старым статусом в WHERE: две
   * конкурирующие смены статуса не пройдут обе — вторая не найдёт строку
   * в исходном состоянии и получит 409.
   */
  async transition(input: {
    lotId: string;
    to: LotStatus;
    actor: LotTransitionActor;
    actorId: string | null;
  }): Promise<LotView> {
    const lot = await this.prisma.lot.findUnique({ where: { id: input.lotId } });
    if (!lot) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }

    const check = checkTransition(lot.status, input.to, input.actor);
    if (!check.allowed) {
      throw new ConflictException({ code: 'INVALID_TRANSITION', message: check.reason });
    }

    const result = await this.prisma.lot.updateMany({
      where: { id: lot.id, status: lot.status },
      data: { status: input.to },
    });
    if (result.count === 0) {
      // Кто-то успел изменить статус между чтением и записью.
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: 'Статус лота изменился, повторите операцию',
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actor: input.actorId ?? 'SYSTEM',
        action: 'lot.transition',
        entity: 'lots',
        entityId: lot.id,
        payloadJson: {
          from: lot.status,
          to: input.to,
          asRole: input.actor,
          description: transitionDescription(lot.status, input.to),
        },
        serverTs: new Date(this.time.wallClockMs()),
      },
    });

    const fresh = await this.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    return toView(fresh, fresh.viewsCount);
  }

  private async requireOwnLot(lotId: string, sellerId: string): Promise<Lot> {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot) {
      throw new NotFoundException({ code: 'LOT_NOT_FOUND' });
    }
    if (lot.sellerId !== sellerId) {
      // Владение — в сервисе, роль — в гварде (CLAUDE.md §4.5).
      throw new ForbiddenException({ code: 'NOT_LOT_OWNER' });
    }
    return lot;
  }
}
