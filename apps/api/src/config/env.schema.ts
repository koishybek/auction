import { z } from 'zod';

/**
 * Схема окружения — единственный источник истины по конфигу (CLAUDE.md §4.1):
 * тип выводится из неё через z.infer, руками не дублируется.
 *
 * Валидация выполняется на старте: приложение либо поднимается с корректным
 * конфигом, либо не поднимается вовсе. Наполовину сконфигурированный сервис,
 * который выясняет про кривой DATABASE_URL в момент первой ставки, нам не нужен.
 */

/**
 * Строка подключения. Проверяем конструктором URL, а не z.url():
 * схемы postgresql:// и rediss:// нестандартны, и разные версии Zod
 * относятся к ним по-разному.
 */
const connectionUrl = (label: string) =>
  z.string().refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: `${label}: ожидается строка подключения вида scheme://host/...` },
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: connectionUrl('DATABASE_URL'),
  /** Без пулера: Prisma нужны DDL и advisory-локи, через PgBouncer они не работают. */
  DIRECT_URL: connectionUrl('DIRECT_URL'),
  REDIS_URL: connectionUrl('REDIS_URL'),

  /** Читаемые логи вместо JSON. Только для локальной отладки: в CI и проде — JSON. */
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Валидатор для ConfigModule. Сообщение об ошибке собираем сами: дефолтный дамп
 * Zod в консоли при падении старта читать невозможно.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(корень)'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Некорректное окружение, приложение не запущено:\n${problems}\n\n` +
      `Проверь .env (шаблон — .env.example, инструкция — docs/dev-setup.md).`,
  );
}
