import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

import { blindIndex, decryptPii, encryptPii, parseKey, type PiiPurpose } from './pii-crypto';

/**
 * Обёртка над примитивами шифрования ПДн: держит ключи и не даёт разбрестись
 * вызовам с разными ключами по коду.
 *
 * Ключи читаются один раз на старте. Если они кривые, приложение падает здесь,
 * а не в момент первой записи персональных данных.
 */
@Injectable()
export class PiiCryptoService {
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(config: ConfigService<Env, true>) {
    this.encryptionKey = parseKey(
      config.get('PII_ENCRYPTION_KEY', { infer: true }),
      'PII_ENCRYPTION_KEY',
    );
    this.indexKey = parseKey(
      config.get('PII_BLIND_INDEX_KEY', { infer: true }),
      'PII_BLIND_INDEX_KEY',
    );
  }

  encrypt(plaintext: string, purpose: PiiPurpose): Buffer {
    return encryptPii(plaintext, this.encryptionKey, purpose);
  }

  decrypt(blob: Buffer, purpose: PiiPurpose): string {
    return decryptPii(blob, this.encryptionKey, purpose);
  }

  /** Индекс для поиска по ИИН — им заполняется колонка `users.iin_blind_idx`. */
  index(value: string): string {
    return blindIndex(value, this.indexKey);
  }

  /** Шифрует значение и сразу отдаёт индекс: два поля всегда пишутся вместе. */
  encryptSearchable(
    plaintext: string,
    purpose: PiiPurpose,
  ): { readonly encrypted: Buffer; readonly index: string } {
    return { encrypted: this.encrypt(plaintext, purpose), index: this.index(plaintext) };
  }
}
