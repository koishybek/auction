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

/**
 * Ключ ровно на 32 байта в base64 (AES-256 / HMAC-SHA256).
 * Проверяем длину, а не «непустоту»: короткий ключ молча ослабляет шифрование,
 * и заметить это по поведению приложения невозможно.
 */
const key32 = (label: string) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    {
      message:
        `${label}: нужен ключ ровно на 32 байта в base64. ` +
        `Сгенерировать: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    },
  );

/** Длительность вида 15m, 30d, 3600s — тот же формат, что понимает parseDuration. */
const duration = (label: string) =>
  z.string().regex(/^\d+\s*(ms|s|m|h|d)$/, `${label}: ожидается длительность вида 15m, 30d, 3600s`);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Порт WebSocket-gateway. Там же отдаётся /health для проб Kubernetes. */
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3200),

  /**
   * Порт сбора метрик Prometheus. Свой у каждого процесса.
   *
   * Отдельный от API намеренно: ingress публикует наружу весь префикс `/api`, и
   * ручка метрик в нём означала бы, что размеры комнат, поток ставок и
   * разбивка отказов по кодам доступны любому. В ingress этого порта нет, и
   * снаружи он недостижим.
   */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),

  /**
   * Сколько доверенных прокси стоит перед API. 0 — никого, адрес клиента берётся
   * из сокета.
   *
   * Число, а не «true»: Express с `trust proxy: true` верит всему X-Forwarded-For
   * целиком, а его дописывает кто угодно. Клиент отправляет свой заголовок,
   * попадает первым в списке — и подменяет себе IP, обходя любые ограничения
   * по адресу. Считать надо ровно столько хопов, сколько их реально стоит
   * (в проде: Cloudflare + ingress).
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /**
   * Доверять заголовку `CF-Connecting-IP` (T-050, NFR-05).
   *
   * Включается ТОЛЬКО когда origin закрыт для всех, кроме сетей Cloudflare.
   * Иначе любой, кто достучался до origin напрямую, назовёт себя любым
   * адресом — и лимит ставок с антинакруткой просмотров начнут верить ему на
   * слово. По умолчанию выключено: небезопасная настройка не должна
   * включаться сама.
   */
  /**
   * Секрет Turnstile (ОВ-5, T-050).
   *
   * Пусто — работает мок капчи. В production пустое значение роняет старт:
   * тихий мок на боевом контуре это открытая дверь, а не деградация.
   */
  TURNSTILE_SECRET_KEY: z.string().default(''),

  TRUST_CLOUDFLARE_IP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DATABASE_URL: connectionUrl('DATABASE_URL'),
  /** Без пулера: Prisma нужны DDL и advisory-локи, через PgBouncer они не работают. */
  DIRECT_URL: connectionUrl('DIRECT_URL'),
  REDIS_URL: connectionUrl('REDIS_URL'),
  /**
   * Префикс всех ключей приложения. Разводит стенды и прогон e2e на одном
   * инстансе: у managed-Redis логической базы под тесты обычно просто нет,
   * а чистить чужие ключи по SCAN без префикса — значит однажды снести
   * состояние живых торгов.
   */
  REDIS_NAMESPACE: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'REDIS_NAMESPACE: строчные латинские буквы, цифры и дефис')
    .default('auction'),

  /** Шифрование ПДн (AES-256-GCM). В проде — из KMS, а не из файла. */
  PII_ENCRYPTION_KEY: key32('PII_ENCRYPTION_KEY'),
  /**
   * Отдельный ключ для blind index (HMAC). Именно отдельный: он детерминирован,
   * и его утечка компрометирует поиск, но не сами данные.
   */
  PII_BLIND_INDEX_KEY: key32('PII_BLIND_INDEX_KEY'),

  /**
   * Секреты подписи JWT. Разные для access и refresh: иначе access-токен,
   * утёкший из лога или браузера, годился бы и на обновление сессии.
   */
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET: минимум 32 символа, иначе подпись подбирается'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET: минимум 32 символа, иначе подпись подбирается'),

  /**
   * Access живёт коротко: отозвать выданный JWT нельзя, только дождаться истечения.
   * Формат проверяем на старте — опечатка «15min» иначе всплыла бы при первом входе.
   */
  JWT_ACCESS_TTL: duration('JWT_ACCESS_TTL').default('15m'),
  JWT_REFRESH_TTL: duration('JWT_REFRESH_TTL').default('30d'),

  /**
   * Корень локального файлового хранилища (Data Room, протоколы, акты).
   * Временная реализация, пока нет реквизитов S3 — см. integrations/storage.
   */
  STORAGE_LOCAL_ROOT: z.string().min(1).default('.storage'),

  /**
   * Как часто накопленные в Redis просмотры сбрасываются в PostgreSQL (T-017).
   * Это операционная ручка: чаще — точнее цифра у продавца, реже — меньше
   * записей в БД. На корректность не влияет, недосброшенное всё равно
   * прибавляется к ответу на лету.
   */
  LOT_VIEWS_FLUSH_MS: z.coerce.number().int().min(1_000).default(30_000),

  /**
   * Период перепроверки лотов в КИСИП/ЕРД. ТЗ §5.1 требует раз в 24 часа —
   * это значение по умолчанию. Ручка нужна прежде всего stage, где ждать
   * сутки ради проверки крона бессмысленно.
   */
  REGISTRY_RECHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(24 * 60 * 60 * 1000),

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
