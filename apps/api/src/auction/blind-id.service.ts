import { createHash, randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { isUniqueViolation } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Разрядность кода растёт по мере заполнения лота.
 *
 * ТЗ §3.1 задаёт три знака — «Инвестор #704». Их хватает на тысячу вариантов, а
 * приёмка требует пять тысяч участников на лоте (ОВ-9). Поэтому три знака
 * остаются, пока лот не заполнен, и расширяются, когда свободных мест
 * становится мало: иначе последние участники перебирали бы занятые коды
 * десятками попыток.
 *
 * Порог — половина пространства: дальше вероятность промаха превышает 50 % и
 * растёт лавинообразно.
 */
const WIDTHS = [
  { width: 3, capacity: 1_000, until: 500 },
  { width: 4, capacity: 10_000, until: 5_000 },
  { width: 5, capacity: 100_000, until: Number.MAX_SAFE_INTEGER },
] as const;

/** Сколько раз пробуем подобрать свободный код, прежде чем признать поражение. */
const MAX_ATTEMPTS = 40;

/**
 * Blind ID — псевдоним участника в рамках лота (T-029, FR-09).
 *
 * Смысл механизма — не «скрыть имя для красоты», а не дать построить картель:
 * если участники узнают друг друга между лотами, они договорятся не перебивать.
 * Поэтому код уникален внутри лота и МЕНЯЕТСЯ от лота к лоту — он выводится из
 * пары «участник + лот», а не из участника.
 *
 * Реальные ФИО, ИИН и id в ленту не попадают никогда: наружу уходит только код.
 */
@Injectable()
export class BlindIdService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Псевдоним участника в лоте. Выдаётся один раз и потом не меняется:
   * участник, сменивший номер посреди торгов, выглядел бы как второй человек.
   */
  async codeFor(lotId: string, userId: string): Promise<string> {
    const existing = await this.prisma.blindId.findUnique({
      where: { lotId_userId: { lotId, userId } },
      select: { code: true },
    });
    if (existing !== null) {
      return existing.code;
    }

    const taken = await this.prisma.blindId.count({ where: { lotId } });
    const { width, capacity } = pickWidth(taken);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Первая попытка — по формуле ТЗ §3.1: хеш от пары «участник + лот».
      // Дальше случайный подбор: детерминированный код уже занят, и повторять
      // его бессмысленно.
      const code =
        attempt === 0
          ? deterministicCode(userId, lotId, width)
          : String(randomInt(capacity)).padStart(width, '0');

      try {
        await this.prisma.blindId.create({ data: { lotId, userId, code } });
        return code;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        /**
         * Ключей два — «участник в лоте» и «код в лоте», — и при
         * одновременных запросах одного участника нарушаются оба сразу.
         * Разбирать, о каком именно сообщила БД, бессмысленно: имя
         * ограничения зависит от версии драйвера и порядка индексов.
         *
         * Вместо этого спрашиваем прямо: получил ли участник номер? Получил —
         * отдаём его. Нет — значит код занял кто-то другой, подбираем
         * следующий.
         */
        const concurrent = await this.prisma.blindId.findUnique({
          where: { lotId_userId: { lotId, userId } },
          select: { code: true },
        });
        if (concurrent !== null) {
          return concurrent.code;
        }
      }
    }

    // Сюда попасть можно только при заполненном пространстве кодов: при
    // расширении разрядности этого не случается, но молчать нельзя.
    throw new Error(
      `Лот ${lotId}: не удалось подобрать свободный Blind ID за ${String(MAX_ATTEMPTS)} попыток`,
    );
  }

  /** Показ в ленте и в модалке завершения: «Инвестор #704» (ТЗ §3.1). */
  static label(code: string): string {
    return `Инвестор #${code}`;
  }
}

/** Разрядность и ёмкость по числу уже выданных кодов. */
function pickWidth(taken: number): { width: number; capacity: number } {
  const chosen = WIDTHS.find((option) => taken < option.until) ?? WIDTHS[2];
  return { width: chosen.width, capacity: chosen.capacity };
}

/**
 * Код по формуле ТЗ: хеш от «участник + лот», обрезанный до нужной длины.
 *
 * Именно пара, а не один участник: один и тот же человек обязан получать разные
 * номера в разных лотах, иначе анонимность держится ровно до второго аукциона.
 */
function deterministicCode(userId: string, lotId: string, width: number): string {
  const digest = createHash('sha256').update(`${userId}:${lotId}`).digest();
  const value = digest.readUInt32BE(0) % 10 ** width;
  return String(value).padStart(width, '0');
}
