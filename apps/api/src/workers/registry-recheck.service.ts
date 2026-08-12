import { Inject, Injectable, Logger } from '@nestjs/common';

import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import { REGISTRY_PROVIDER, type RegistryProvider } from '../integrations/registry/registry.types';
import { LotsService } from '../lots/lots.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import {
  RECHECKED_STATUSES,
  TEMPLATE_LOT_PAUSED,
  TEMPLATE_RESTRICTION_DURING_BIDDING,
} from './workers.constants';

/**
 * Чем закончилась перепроверка одного лота. Разбирается вызывающим для логов и
 * для теста: молчаливое «ничего не произошло» и «ограничение найдено, но лот не
 * остановлен» — разные вещи, и путать их нельзя.
 */
export type RecheckOutcome =
  | { readonly kind: 'CLEAN' }
  | { readonly kind: 'PAUSED'; readonly restrictions: readonly string[] }
  | { readonly kind: 'RESTRICTED_WHILE_LIVE'; readonly restrictions: readonly string[] }
  | { readonly kind: 'SKIPPED'; readonly reason: string };

/** Размер страницы обхода. Keyset, а не OFFSET: обход не должен дорожать к концу. */
const PAGE_SIZE = 500;

/**
 * Перепроверка лотов в КИСИП/ЕРД (INT-02, T-020).
 *
 * ТЗ §5.1 требует запрашивать реестр при создании лота и раз в 24 часа: арест
 * или обременение может появиться уже после публикации, и торговать таким
 * объектом нельзя.
 *
 * Логика вынесена из воркера в сервис, чтобы её можно было вызвать напрямую —
 * и из теста, и из ручной админской перепроверки, когда она появится.
 */
@Injectable()
export class RegistryRecheckService {
  private readonly logger = new Logger(RegistryRecheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCryptoService,
    private readonly lots: LotsService,
    private readonly time: TimeService,
    @Inject(REGISTRY_PROVIDER) private readonly registry: RegistryProvider,
  ) {}

  /** Идентификаторы лотов, подлежащих перепроверке. */
  async listActiveLotIds(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.lot.findMany({
        where: { status: { in: [...RECHECKED_STATUSES] } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (page.length === 0) {
        return ids;
      }
      ids.push(...page.map((lot) => lot.id));
      cursor = page[page.length - 1]?.id;
    }
  }

  /**
   * Перепроверить один лот.
   *
   * Результат проверки пишется в registry_checks всегда, включая чистый: история
   * проверок — часть досье лота, и «когда в последний раз смотрели» на споре о
   * сделке значит не меньше, чем сам факт ограничения.
   */
  async recheckLot(lotId: string): Promise<RecheckOutcome> {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (lot === null) {
      return { kind: 'SKIPPED', reason: 'лот удалён' };
    }
    if (!RECHECKED_STATUSES.includes(lot.status)) {
      // Статус мог измениться между обходом и обработкой задачи.
      return { kind: 'SKIPPED', reason: `статус ${lot.status} перепроверке не подлежит` };
    }

    const seller = await this.prisma.user.findUnique({ where: { id: lot.sellerId } });
    if (seller?.iinEnc == null) {
      // Реестр проверяет по ИИН собственника — без него запрос бессмысленен.
      return { kind: 'SKIPPED', reason: 'у продавца нет верифицированного ИИН' };
    }

    const result = await this.registry.check({
      iinOrBin: this.pii.decrypt(seller.iinEnc, 'users.iin'),
      cadastreOrVin: lot.cadastreOrVin,
    });

    await this.prisma.registryCheck.create({
      data: {
        lotId: lot.id,
        hasRestriction: result.hasRestriction,
        payloadJson: result.payload,
        checkedAt: new Date(this.time.wallClockMs()),
      },
    });

    if (!result.hasRestriction) {
      return { kind: 'CLEAN' };
    }

    /**
     * Из PHASE_III перехода в PAUSED нет — и это осознанное решение статусной
     * машины: остановка живых торгов делается механизмом SLA Freeze (FR-08),
     * иначе появятся два конкурирующих способа паузы с разной семантикой.
     *
     * Поэтому ограничение, найденное во время торгов, не гасит их молча и не
     * ломает машину: оно фиксируется и уходит администраторам как инцидент.
     * Что делать дальше — решение человека, а не крона (см. вопрос в TASKS).
     */
    if (lot.status === 'PHASE_III') {
      this.logger.error(
        `Лот ${lot.id}: ограничение реестра во время торгов — ${result.restrictions.join('; ')}`,
      );
      await this.notifyAdmins(TEMPLATE_RESTRICTION_DURING_BIDDING);
      return { kind: 'RESTRICTED_WHILE_LIVE', restrictions: result.restrictions };
    }

    await this.lots.transition({ lotId: lot.id, to: 'PAUSED', actor: 'SYSTEM', actorId: null });
    await this.notify(lot.sellerId, TEMPLATE_LOT_PAUSED);

    this.logger.warn(`Лот ${lot.id} остановлен: ${result.restrictions.join('; ')}`);
    return { kind: 'PAUSED', restrictions: result.restrictions };
  }

  /**
   * Уведомление кладётся в notifications со статусом PENDING. Отправку заберёт
   * адаптер Push/SMS (T-033) — здесь мы фиксируем, что уведомить нужно, а не
   * притворяемся, что уже уведомили.
   */
  private async notify(userId: string, template: string): Promise<void> {
    await this.prisma.notification.create({
      data: { userId, channel: 'PUSH', template, status: 'PENDING' },
    });
  }

  private async notifyAdmins(template: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'ADMIN' }, status: 'ACTIVE' },
      select: { id: true },
    });
    await this.prisma.notification.createMany({
      data: admins.map((admin) => ({
        userId: admin.id,
        channel: 'PUSH' as const,
        template,
        status: 'PENDING' as const,
      })),
    });
  }
}
