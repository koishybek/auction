import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { TimeService } from '../time/time.service';

import { DepositsService, REFUND_SLA_MS } from './deposits.service';

/**
 * Сколько участник №2 решает, какую опцию выбрать (ОВ-14).
 *
 * ТЗ срок не задаёт, а он необходим: Опция Б обещает возврат 100 % за 24 часа
 * от закрытия торгов, и окно выбора обязано быть заметно меньше суток. Час —
 * компромисс: человек успевает увидеть уведомление и ответить, а поручение на
 * возврат всё ещё уходит с запасом внутри SLA. Не ответил — считается Опция Б:
 * молчание возвращает деньги, а не удерживает их.
 */
export const RUNNER_UP_CHOICE_MS = 60 * 60 * 1000;

/**
 * Сколько держится задаток по Опции А.
 *
 * Пять банковских дней — ровно срок доплаты победителя (ОВ-10). Держать
 * дольше нечего: право выкупа возникает из дефолта победителя, а дефолт
 * наступает по истечении этого срока.
 */
export const RUNNER_UP_HOLD_MS = 5 * 24 * 60 * 60 * 1000;

/** Что выбирает участник №2 (FR-14). */
export const RUNNER_UP_OPTIONS = ['A', 'B'] as const;
export type RunnerUpOption = (typeof RUNNER_UP_OPTIONS)[number];

export interface RunnerUpView {
  readonly lotId: string;
  /** Предложен ли выбор прямо сейчас. */
  readonly offered: boolean;
  readonly option: RunnerUpOption | null;
  /** Остаток текущего шага: сначала на выбор, потом на удержание. */
  readonly remainingMs: number | null;
}

/**
 * Runner-Up: опции А и Б (T-038, FR-14, ОВ-10).
 *
 * Участник №2 определяется в момент закрытия торгов — тем же атомарным
 * скриптом, что назвал победителя. По ставкам в PostgreSQL его вычислять
 * нельзя: они доезжают туда асинхронно, а решение удержать задаток
 * принимается сразу, иначе воркер возвратов успеет отправить поручение.
 *
 * Опция А — задаток остаётся на спецсчёте пять дней под дефолт победителя.
 * Опция Б — обычный возврат: сто процентов в течение суток от закрытия торгов.
 */
@Injectable()
export class RunnerUpService {
  private readonly logger = new Logger(RunnerUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositsService,
    private readonly time: TimeService,
  ) {}

  /**
   * Предложить выбор участнику №2 сразу после закрытия торгов.
   *
   * Метка срока и означает «это задаток участника №2»: отдельного флага нет,
   * два признака одного факта неизбежно разъезжаются.
   */
  async offer(input: { lotId: string; userId: string; finishedAtMs: number }): Promise<boolean> {
    const updated = await this.prisma.deposit.updateMany({
      where: { lotId: input.lotId, userId: input.userId, status: 'ON_SPECIAL_ACCOUNT' },
      data: { runnerUpUntil: new Date(input.finishedAtMs + RUNNER_UP_CHOICE_MS) },
    });
    if (updated.count === 0) {
      // Задатка нет или он уже не на спецсчёте — предлагать нечего.
      return false;
    }
    this.logger.log(`Лот ${input.lotId}: участнику №2 предложен выбор опции`);
    return true;
  }

  /** Что видит участник по этому лоту. */
  async view(lotId: string, userId: string): Promise<RunnerUpView> {
    const deposit = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId, lotId } },
      select: { status: true, runnerUpUntil: true },
    });

    if (deposit?.runnerUpUntil == null) {
      return { lotId, offered: false, option: null, remainingMs: null };
    }

    const remainingMs = Math.max(0, deposit.runnerUpUntil.getTime() - this.time.wallClockMs());
    if (deposit.status === 'RUNNERUP_HOLD') {
      return { lotId, offered: false, option: 'A', remainingMs };
    }
    if (deposit.status === 'ON_SPECIAL_ACCOUNT') {
      // Срок вышел — выбор больше не предлагается, задаток уходит в возврат.
      return { lotId, offered: remainingMs > 0, option: null, remainingMs };
    }
    // Возврат уже запущен: выбор сделан или истёк.
    return { lotId, offered: false, option: 'B', remainingMs: null };
  }

  /** Выбор участника №2. */
  async choose(input: {
    lotId: string;
    userId: string;
    option: RunnerUpOption;
  }): Promise<RunnerUpView> {
    const deposit = await this.prisma.deposit.findUnique({
      where: { userId_lotId: { userId: input.userId, lotId: input.lotId } },
      select: { id: true, status: true, runnerUpUntil: true },
    });

    if (deposit?.runnerUpUntil == null || deposit.status !== 'ON_SPECIAL_ACCOUNT') {
      // Выбор предлагается ровно одному человеку и ровно один раз.
      throw new ForbiddenException({ code: 'RUNNER_UP_NOT_OFFERED' });
    }
    if (deposit.runnerUpUntil.getTime() <= this.time.wallClockMs()) {
      throw new BadRequestException({ code: 'RUNNER_UP_CHOICE_EXPIRED' });
    }

    if (input.option === 'A') {
      await this.deposits.transition({
        depositId: deposit.id,
        to: 'RUNNERUP_HOLD',
        actor: 'SYSTEM',
        actorId: input.userId,
        reason: 'участник №2 выбрал Опцию А: задаток под дефолт победителя',
      });
      await this.prisma.deposit.updateMany({
        where: { id: deposit.id },
        data: { runnerUpUntil: new Date(this.time.wallClockMs() + RUNNER_UP_HOLD_MS) },
      });
    } else {
      await this.startRefund(deposit.id, input.lotId, 'участник №2 выбрал Опцию Б');
    }

    return this.view(input.lotId, input.userId);
  }

  /**
   * Просроченные шаги сценария: молчание участника и истёкшее удержание.
   *
   * Оба исхода одинаковы — возврат. Разница в причине, и она попадает в
   * audit_log: по записи должно быть видно, отказался человек сам или просто
   * не ответил.
   */
  async expireDue(): Promise<number> {
    const now = new Date(this.time.wallClockMs());
    const due = await this.prisma.deposit.findMany({
      where: {
        runnerUpUntil: { lt: now },
        status: { in: ['ON_SPECIAL_ACCOUNT', 'RUNNERUP_HOLD'] },
      },
      select: { id: true, lotId: true, status: true },
      take: 100,
    });

    let closed = 0;
    for (const deposit of due) {
      const reason =
        deposit.status === 'RUNNERUP_HOLD'
          ? 'Опция А истекла: победитель рассчитался либо срок вышел'
          : 'участник №2 не ответил — по умолчанию Опция Б';
      try {
        await this.startRefund(deposit.id, deposit.lotId, reason);
        closed += 1;
      } catch (error) {
        this.logger.error(
          `Задаток ${deposit.id}: сценарий Runner-Up не закрыт — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (closed > 0) {
      this.logger.log(`Сценарий Runner-Up закрыт по сроку: ${String(closed)}`);
    }
    return closed;
  }

  /**
   * Запустить возврат участнику №2.
   *
   * Срок возврата считается от ЗАКРЫТИЯ ТОРГОВ, а не от этого момента: ТЗ
   * обещает сто процентов за 24 часа, и час размышлений участника не должен
   * растягивать обещание до двадцати пяти.
   */
  private async startRefund(depositId: string, lotId: string, reason: string): Promise<void> {
    const session = await this.prisma.auctionSession.findFirst({
      where: { lotId, status: 'FINISHED' },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    const finishedAt = session?.finishedAt ?? new Date(this.time.wallClockMs());

    await this.deposits.transition({
      depositId,
      to: 'REFUND_PENDING',
      actor: 'SYSTEM',
      actorId: null,
      reason,
      refundDeadlineAt: new Date(finishedAt.getTime() + REFUND_SLA_MS),
    });
    // Метку срока не стираем: она осталась единственным следом того, что этот
    // задаток был задатком участника №2. Повторно её никто не прочтёт —
    // просроченные шаги ищутся только среди задатков на спецсчёте и в
    // удержании, а этот уже в возврате.
  }
}
