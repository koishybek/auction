import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

import {
  blindIndex,
  decryptPii,
  encryptPii,
  parseKey,
  pseudonym as pseudonymOf,
  type PiiPurpose,
} from './pii-crypto';

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

  /**
   * Возвращает тип, который Prisma принимает в колонку Bytes
   * (`Uint8Array<ArrayBuffer>`). Копия небольшая — ПДн короткие, зато
   * конвертация живёт в одной точке, а не у каждого вызова записи.
   */
  encrypt(plaintext: string, purpose: PiiPurpose): Uint8Array<ArrayBuffer> {
    return new Uint8Array(encryptPii(plaintext, this.encryptionKey, purpose));
  }

  /** Принимает то, что Prisma отдаёт из колонки Bytes. Buffer.from здесь без копии. */
  decrypt(blob: Uint8Array, purpose: PiiPurpose): string {
    return decryptPii(
      Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength),
      this.encryptionKey,
      purpose,
    );
  }

  /** Индекс для поиска по ИИН — им заполняется колонка `users.iin_blind_idx`. */
  index(value: string): string {
    return blindIndex(value, this.indexKey);
  }

  /**
   * Псевдоним для узнавания повторов без хранения исходника (IP+User-Agent
   * в антинакрутке просмотров). Домен разводит назначения между собой.
   */
  pseudonym(value: string, domain: string): string {
    return pseudonymOf(value, this.indexKey, domain);
  }

  /** Шифрует значение и сразу отдаёт индекс: два поля всегда пишутся вместе. */
  encryptSearchable(
    plaintext: string,
    purpose: PiiPurpose,
  ): { readonly encrypted: Uint8Array<ArrayBuffer>; readonly index: string } {
    return { encrypted: this.encrypt(plaintext, purpose), index: this.index(plaintext) };
  }
}
