import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  blindIndex,
  blindIndexEquals,
  decryptPii,
  encryptPii,
  normalizeForIndex,
  parseKey,
  PiiCryptoError,
  pseudonym,
} from './pii-crypto';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const INDEX_KEY = randomBytes(32);

const IIN = '900101300123';
const FIO = 'Мұхаметқали Әбдіраманұлы';

describe('шифрование ПДн', () => {
  it('расшифровывает то, что зашифровало, включая кириллицу и казахские буквы', () => {
    const blob = encryptPii(FIO, KEY, 'users.fio');
    expect(decryptPii(blob, KEY, 'users.fio')).toBe(FIO);
  });

  it('не оставляет открытый текст в шифротексте', () => {
    const blob = encryptPii(IIN, KEY, 'users.iin');
    expect(blob.toString('utf8')).not.toContain(IIN);
    expect(blob.toString('latin1')).not.toContain(IIN);
  });

  it('шифрует одно и то же значение каждый раз по-разному', () => {
    // Иначе по шифротексту видно, что у двух участников совпадает телефон.
    const a = encryptPii(IIN, KEY, 'users.iin');
    const b = encryptPii(IIN, KEY, 'users.iin');
    expect(a.equals(b)).toBe(false);
    expect(decryptPii(a, KEY, 'users.iin')).toBe(decryptPii(b, KEY, 'users.iin'));
  });

  it('отвергает чужой ключ', () => {
    const blob = encryptPii(IIN, KEY, 'users.iin');
    expect(() => decryptPii(blob, OTHER_KEY, 'users.iin')).toThrow(PiiCryptoError);
  });

  it('отвергает блоб, переставленный в другую колонку', () => {
    // Атакующий с правом записи в БД не подменит человеку ИИН его же телефоном.
    const blob = encryptPii(IIN, KEY, 'users.iin');
    expect(() => decryptPii(blob, KEY, 'users.phone')).toThrow(PiiCryptoError);
  });

  it('замечает подмену хотя бы одного байта шифротекста', () => {
    const blob = encryptPii(IIN, KEY, 'users.iin');
    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    expect(() => decryptPii(tampered, KEY, 'users.iin')).toThrow(PiiCryptoError);
  });

  it('замечает подмену тега аутентификации', () => {
    const blob = encryptPii(IIN, KEY, 'users.iin');
    const tampered = Buffer.from(blob);
    tampered[14] = (tampered[14] ?? 0) ^ 0xff;
    expect(() => decryptPii(tampered, KEY, 'users.iin')).toThrow(PiiCryptoError);
  });

  it('отвергает обрезанный блоб', () => {
    const blob = encryptPii(IIN, KEY, 'users.iin');
    expect(() => decryptPii(blob.subarray(0, 10), KEY, 'users.iin')).toThrow(PiiCryptoError);
  });

  it('отвергает неизвестную версию формата', () => {
    const blob = encryptPii(IIN, KEY, 'users.iin');
    const tampered = Buffer.from(blob);
    tampered[0] = 99;
    expect(() => decryptPii(tampered, KEY, 'users.iin')).toThrow(/версия/i);
  });

  it('не пропускает ключ неверной длины', () => {
    expect(() => encryptPii(IIN, randomBytes(16), 'users.iin')).toThrow(PiiCryptoError);
    expect(() => parseKey(randomBytes(16).toString('base64'), 'TEST_KEY')).toThrow(PiiCryptoError);
    expect(parseKey(KEY.toString('base64'), 'TEST_KEY').equals(KEY)).toBe(true);
  });

  it('переносит пустую строку и длинные значения', () => {
    expect(decryptPii(encryptPii('', KEY, 'users.fio'), KEY, 'users.fio')).toBe('');
    const long = 'ә'.repeat(5000);
    expect(decryptPii(encryptPii(long, KEY, 'users.fio'), KEY, 'users.fio')).toBe(long);
  });
});

describe('blind index — поиск по зашифрованному полю', () => {
  it('даёт одинаковый индекс для одинакового значения', () => {
    expect(blindIndex(IIN, INDEX_KEY)).toBe(blindIndex(IIN, INDEX_KEY));
  });

  it('даёт разные индексы для разных значений', () => {
    expect(blindIndex(IIN, INDEX_KEY)).not.toBe(blindIndex('900101300124', INDEX_KEY));
  });

  it('нормализует пробелы и регистр', () => {
    // Иначе один человек заведётся в системе дважды, и проверка занятости лида соврёт.
    const expected = blindIndex(IIN, INDEX_KEY);
    expect(blindIndex(' 900101 300123 ', INDEX_KEY)).toBe(expected);
    expect(blindIndex('900101300123\n', INDEX_KEY)).toBe(expected);
    expect(blindIndex('Aa Bb', INDEX_KEY)).toBe(blindIndex('aabb', INDEX_KEY));
    expect(normalizeForIndex(' 900101 300123 ')).toBe('900101300123');
  });

  it('с другим ключом даёт другой индекс', () => {
    expect(blindIndex(IIN, INDEX_KEY)).not.toBe(blindIndex(IIN, randomBytes(32)));
  });

  it('не пропускает ключ неверной длины', () => {
    expect(() => blindIndex(IIN, randomBytes(31))).toThrow(PiiCryptoError);
  });

  it('сравнивает индексы корректно', () => {
    const a = blindIndex(IIN, INDEX_KEY);
    expect(blindIndexEquals(a, a)).toBe(true);
    expect(blindIndexEquals(a, blindIndex('900101300124', INDEX_KEY))).toBe(false);
    expect(blindIndexEquals(a, '')).toBe(false);
    expect(blindIndexEquals('', '')).toBe(false);
  });
});

describe('pseudonym', () => {
  const FINGERPRINT = '203.0.113.7|Mozilla/5.0';

  it('одинаковый вход даёт одинаковый псевдоним', () => {
    expect(pseudonym(FINGERPRINT, INDEX_KEY, 'lot_views.viewer')).toBe(
      pseudonym(FINGERPRINT, INDEX_KEY, 'lot_views.viewer'),
    );
  });

  it('разные домены разводят один и тот же вход', () => {
    // Иначе по совпадению псевдонимов две подсистемы связываются между собой.
    expect(pseudonym(FINGERPRINT, INDEX_KEY, 'lot_views.viewer')).not.toBe(
      pseudonym(FINGERPRINT, INDEX_KEY, 'antibot.client'),
    );
  });

  it('склейка домена и значения однозначна', () => {
    // Без разделителя ('ab' + 'c') и ('a' + 'bc') дали бы один хеш.
    expect(pseudonym('c', INDEX_KEY, 'ab')).not.toBe(pseudonym('bc', INDEX_KEY, 'a'));
  });

  it('не совпадает с blind index того же значения', () => {
    expect(pseudonym(IIN, INDEX_KEY, 'lot_views.viewer')).not.toBe(
      blindIndex(IIN, INDEX_KEY).slice(0, 32),
    );
  });

  it('не пропускает ключ неверной длины', () => {
    expect(() => pseudonym(FINGERPRINT, randomBytes(31), 'lot_views.viewer')).toThrow(
      PiiCryptoError,
    );
  });
});
