import { Inject, Injectable, Logger } from '@nestjs/common';

import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import {
  NOTIFICATION_PROVIDER,
  type NotificationChannelValue,
  type NotificationPriority,
  type NotificationProvider,
} from '../integrations/notifications/notification.types';
import { PrismaService } from '../prisma/prisma.service';

/** Шаблоны. Текст живёт у провайдера, здесь только идентификаторы. */
export const TEMPLATE_SLA_FREEZE = 'auction.sla_freeze';
export const TEMPLATE_SLA_RESUME = 'auction.sla_resume';

/**
 * Уведомления участников (T-033, FR-08).
 *
 * Отправка и запись — одно действие: строка в `notifications` появляется
 * всегда, даже если провайдер отказал. Иначе разбор жалобы «мне не пришло»
 * упирался бы в пустоту: неизвестно, не отправляли или не доставили.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCryptoService,
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
  ) {}

  /**
   * Кто считается участником лота.
   *
   * Двое: те, кто внёс задаток, и те, кто уже ставил. Первые держат деньги на
   * спецсчёте и обязаны знать о паузе; вторые в торгах фактически, даже если
   * задаток по какой-то причине сменил статус. Множества почти совпадают, но
   * брать только одно значит однажды промолчать перед человеком с деньгами.
   */
  async lotParticipants(lotId: string): Promise<string[]> {
    const [deposits, bidders] = await Promise.all([
      this.prisma.deposit.findMany({ where: { lotId }, select: { userId: true } }),
      this.prisma.bid.findMany({
        where: { lotId },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);
    return [...new Set([...deposits, ...bidders].map((row) => row.userId))];
  }

  /** Уведомить всех участников лота. Возвращает число доставленных. */
  async notifyLotParticipants(input: {
    lotId: string;
    template: string;
    params: Readonly<Record<string, string | number>>;
    priority?: NotificationPriority;
    channel?: NotificationChannelValue;
  }): Promise<{ attempted: number; delivered: number }> {
    const participants = await this.lotParticipants(input.lotId);
    let delivered = 0;

    for (const userId of participants) {
      if (await this.notify({ ...input, userId })) {
        delivered += 1;
      }
    }

    this.logger.log(
      `Лот ${input.lotId}: ${input.template} — доставлено ${String(delivered)} из ` +
        `${String(participants.length)}`,
    );
    return { attempted: participants.length, delivered };
  }

  /**
   * Уведомить одного. Строка пишется до отправки и обновляется по результату:
   * упади процесс между ними — останется PENDING, а не тишина.
   */
  async notify(input: {
    userId: string;
    template: string;
    params: Readonly<Record<string, string | number>>;
    priority?: NotificationPriority;
    channel?: NotificationChannelValue;
  }): Promise<boolean> {
    const channel = input.channel ?? 'PUSH';
    const record = await this.prisma.notification.create({
      data: { userId: input.userId, channel, template: input.template, status: 'PENDING' },
      select: { id: true },
    });

    const result = await this.provider.send({
      userId: input.userId,
      channel,
      template: input.template,
      params: input.params,
      phone: channel === 'SMS' ? await this.phoneOf(input.userId) : null,
      priority: input.priority ?? 'NORMAL',
    });

    await this.prisma.notification.update({
      where: { id: record.id },
      data: {
        status: result.delivered ? 'SENT' : 'FAILED',
        sentAt: result.delivered ? new Date() : null,
      },
    });
    return result.delivered;
  }

  /**
   * Телефон участника открытым текстом — только на границе с провайдером.
   *
   * Расшифрованное значение никуда не сохраняется и не попадает в логи:
   * оператору связи номер нужен, нашей базе и системе сбора логов — нет.
   */
  private async phoneOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneEnc: true },
    });
    if (user?.phoneEnc == null) {
      return null;
    }
    return this.pii.decrypt(user.phoneEnc, 'users.phone');
  }
}
