import { z } from 'zod';

/**
 * Схемы входящих сообщений WebSocket.
 *
 * Валидация — только Zod, как и в REST (CLAUDE.md §4.1). Здесь это критичнее,
 * чем на REST: сообщение из сокета не проходит ни через один пайп Nest, и
 * единственная защита от мусора в обработчике ставки — эта схема.
 *
 * `.strict()` обязателен: лишнее поле в сообщении должно быть отказом, а не
 * молча выброшенным ключом (QA-04).
 */

/** Все входящие сообщения различаются полем `event` — оно же дискриминант. */
const JoinLotSchema = z
  .object({
    event: z.literal('join_lot'),
    lot_id: z.string().uuid(),
    /**
     * Токен доступа. Необязателен: каталог и ход торгов публичны, смотреть
     * может кто угодно. Право ставить проверяется на самой ставке (T-025).
     * Но если токен предъявлен и он битый — это ошибка, а не «считаем гостем»:
     * иначе участник с истёкшим токеном молча смотрел бы торги как аноним и
     * узнал бы об этом в момент, когда ставка не проходит.
     */
    token: z.string().min(1).optional(),
  })
  .strict();

const LeaveLotSchema = z
  .object({
    event: z.literal('leave_lot'),
    lot_id: z.string().uuid(),
  })
  .strict();

const PongSchema = z
  .object({
    event: z.literal('pong'),
  })
  .strict();

/**
 * Ставка (ТЗ §2.1, FR-04).
 *
 * Сумма обязательна и приходит в ТЕНГЕ — та самая, что участник видел на
 * кнопке. Источником она не является: сервер считает цену сам, а присланное
 * число сверяет. Не совпало — значит между отрисовкой кнопки и кликом кто-то
 * успел поставить, и человек нажал не на ту цену, которую видел (QA-04).
 *
 * Токена здесь нет: соединение уже опознано — кукой при рукопожатии или
 * токеном в `join_lot`. Второй способ предъявить себя на том же соединении
 * означал бы, что ставку можно сделать от чужого имени, подложив свой токен
 * в чужой сокет.
 */
/**
 * Поведенческие сигналы клика (FR-11).
 *
 * Необязательны: их отсутствие — не отказ, а повод показать капчу. Сырых
 * координат здесь нет намеренно — траектория указателя это данные о человеке,
 * а для проверки «двигался или нет» хватает агрегатов.
 */
const BehaviorSchema = z
  .object({
    trusted: z.boolean(),
    kind: z.enum(['mouse', 'touch', 'pen', 'keyboard', 'unknown']),
    moves: z.number().int().min(0).max(10_000),
    path_px: z.number().int().min(0).max(1_000_000),
    dwell_ms: z.number().int().min(0).max(600_000),
  })
  .strict();

const PlaceBidSchema = z
  .object({
    event: z.literal('place_bid'),
    lot_id: z.string().uuid(),
    amount_kzt: z.number().int().positive(),
    behavior: BehaviorSchema.optional(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('event', [
  JoinLotSchema,
  LeaveLotSchema,
  PlaceBidSchema,
  PongSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * Разобрать сырой кадр из сокета.
 *
 * Вход типизирован как `unknown` и сужается схемой — из сокета приходят байты,
 * а не наш тип. Ограничение на размер стоит до JSON.parse: разбор мегабайтного
 * кадра на 50 000 соединений — это способ положить gateway без единой ставки.
 */
export function parseClientMessage(
  raw: string,
  maxBytes: number,
): { ok: true; message: ClientMessage } | { ok: false; reason: string } {
  if (raw.length > maxBytes) {
    return { ok: false, reason: `Сообщение длиннее ${String(maxBytes)} байт` };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Не JSON' };
  }

  const parsed = ClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason:
        first === undefined ? 'Не проходит схему' : `${first.path.join('.')}: ${first.message}`,
    };
  }
  return { ok: true, message: parsed.data };
}
