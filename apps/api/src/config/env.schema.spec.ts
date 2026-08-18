import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

/**
 * Проверки окружения на старте (T-055).
 *
 * Смысл этих тестов — не в схеме как таковой, а в том, что нарушение инварианта
 * ПДн валит процесс, а не проходит молча. Приложение, поднявшееся с одним
 * ключом на шифрование и на поиск, выглядит абсолютно здоровым.
 */

function key(): string {
  return randomBytes(32).toString('base64');
}

function baseEnv(over: Record<string, string> = {}): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/auction',
    DIRECT_URL: 'postgresql://postgres@127.0.0.1:5433/auction',
    REDIS_URL: 'redis://127.0.0.1:6379',
    PII_ENCRYPTION_KEY: key(),
    PII_BLIND_INDEX_KEY: key(),
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    ...over,
  };
}

describe('окружение: ключи персональных данных', () => {
  it('два разных ключа проходят проверку', () => {
    const env = validateEnv(baseEnv());
    expect(env.PII_ENCRYPTION_KEY).not.toBe(env.PII_BLIND_INDEX_KEY);
  });

  it('один и тот же ключ на шифрование и на поиск не проходит', () => {
    // Так это и случается: оператор генерирует ключ один раз и вставляет в оба
    // поля секрета. Длина у обоих верная, приложение поднимается штатно.
    const shared = key();
    expect(() =>
      validateEnv(baseEnv({ PII_ENCRYPTION_KEY: shared, PII_BLIND_INDEX_KEY: shared })),
    ).toThrow(/PII_BLIND_INDEX_KEY/u);
  });

  it('короткий ключ не проходит', () => {
    expect(() =>
      validateEnv(baseEnv({ PII_ENCRYPTION_KEY: randomBytes(16).toString('base64') })),
    ).toThrow(/32 байта/u);
  });
});
