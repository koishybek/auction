import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Шифрование персональных данных (ФИО, ИИН, телефон, email) и поиск по ним.
 *
 * Требование ТЗ §3.1: реальные данные участников строго зашифрованы на уровне БД.
 * Практический смысл — дамп базы, украденный или отданный на сторону, не должен
 * раскрывать ни одного человека.
 *
 * Формат хранимого блоба:
 *
 *   [версия 1 байт][IV 12 байт][тег аутентификации 16 байт][шифротекст]
 *
 * Байт версии нужен для смены алгоритма или ключа: старые записи можно будет
 * расшифровать прежним способом, не переписывая всю таблицу разом.
 */

const VERSION_V1 = 1;
const IV_LENGTH = 12; // рекомендованная длина IV для GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
const HEADER_LENGTH = 1 + IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Назначение шифротекста. Уходит в GCM как дополнительные аутентифицируемые данные,
 * поэтому блоб, скопированный из одной колонки в другую, не расшифруется:
 * атакующий с правом записи в БД не подменит человеку ИИН его же телефоном.
 */
export type PiiPurpose =
  'users.fio' | 'users.iin' | 'users.phone' | 'users.email' | 'partner_leads.owner_contact';

export class PiiCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiiCryptoError';
  }
}

function assertKey(key: Buffer, label: string): void {
  if (key.length !== KEY_LENGTH) {
    throw new PiiCryptoError(
      `${label}: ожидается ключ ${String(KEY_LENGTH)} байт, получено ${String(key.length)}`,
    );
  }
}

/** Разобрать ключ из base64. Отдельная функция, чтобы ошибка была внятной, а не «bad key length». */
export function parseKey(base64: string, label: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  assertKey(key, label);
  return key;
}

/**
 * Зашифровать значение. Каждый вызов даёт новый случайный IV, поэтому одно и то же
 * значение шифруется по-разному — по шифротексту нельзя понять, что у двух людей
 * совпадает телефон.
 */
export function encryptPii(plaintext: string, key: Buffer, purpose: PiiPurpose): Buffer {
  assertKey(key, 'ключ шифрования');

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(purpose, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION_V1]), iv, authTag, ciphertext]);
}

/**
 * Расшифровать значение. Бросает, если блоб подделан, обрезан, зашифрован другим
 * ключом или взят из другой колонки — GCM проверяет целостность, а не только
 * расшифровывает.
 */
export function decryptPii(blob: Buffer, key: Buffer, purpose: PiiPurpose): string {
  assertKey(key, 'ключ шифрования');

  if (blob.length < HEADER_LENGTH) {
    throw new PiiCryptoError('Блоб короче заголовка — данные повреждены');
  }

  const version = blob[0];
  if (version !== VERSION_V1) {
    throw new PiiCryptoError(`Неизвестная версия формата: ${String(version)}`);
  }

  const iv = blob.subarray(1, 1 + IV_LENGTH);
  const authTag = blob.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = blob.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Наружу не пробрасываем детали от OpenSSL: они ничего не дают, кроме подсказки атакующему.
    throw new PiiCryptoError(
      'Не удалось расшифровать: неверный ключ, другое назначение или повреждённые данные',
    );
  }
}

/**
 * Нормализация перед вычислением blind index.
 *
 * Без неё «090101 300123» и «090101300123» дадут разные индексы, и один и тот же
 * человек заведётся в системе дважды — а на это завязана проверка занятости лида
 * и допуск к торгам.
 */
export function normalizeForIndex(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Детерминированный индекс для поиска по зашифрованному полю.
 *
 * Шифротекст искать нельзя (у каждой записи свой IV), поэтому рядом лежит HMAC —
 * одинаковый для одинакового значения. Ключ ОБЯЗАН отличаться от ключа шифрования.
 *
 * Остаточный риск: ИИН — это 12 цифр, то есть перебор по всему пространству
 * реалистичен. Если утечёт ключ индекса, соответствие «ИИН → строка» восстановимо,
 * хотя сами ФИО и телефоны останутся зашифрованными. Поэтому ключ индекса живёт
 * в KMS отдельно от БД и отдельно от ключа шифрования.
 */
export function blindIndex(value: string, key: Buffer): string {
  assertKey(key, 'ключ blind index');
  return createHmac('sha256', key).update(normalizeForIndex(value), 'utf8').digest('hex');
}

/** Сравнение индексов за постоянное время — чтобы не отдавать информацию таймингом. */
export function blindIndexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
