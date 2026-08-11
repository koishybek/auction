import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

import type { DownloadHandle, StorageProvider, StoredObject } from './storage.types';

/**
 * Файловое хранилище на локальном диске.
 *
 * Рабочая реализация для dev и e2e, пока нет реквизитов S3. Метаданные
 * (content-type, размер) держим рядом в .meta.json — на диске, в отличие от S3,
 * их хранить негде.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root: string;

  /**
   * Корень берётся из конфига, а не из необязательного аргумента конструктора:
   * Nest внедряет параметры по типу, и `root?: string` он пытается разрешить
   * как провайдер String — модуль просто не поднимается.
   */
  constructor(config: ConfigService<Env, true>) {
    this.root = resolve(config.get('STORAGE_LOCAL_ROOT', { infer: true }));
  }

  async put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    await writeFile(
      `${path}.meta.json`,
      JSON.stringify({ contentType: input.contentType, sizeBytes: input.body.byteLength }),
      'utf8',
    );
    return { key: input.key, sizeBytes: input.body.byteLength, contentType: input.contentType };
  }

  async get(key: string): Promise<DownloadHandle | null> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      const meta = await this.readMeta(path);
      return {
        stream: createReadStream(path),
        sizeBytes: info.size,
        contentType: meta.contentType,
      };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }

  private async readMeta(path: string): Promise<{ contentType: string }> {
    try {
      const parsed: unknown = JSON.parse(await readFile(`${path}.meta.json`, 'utf8'));
      const contentType = (parsed as { contentType?: unknown }).contentType;
      return {
        contentType: typeof contentType === 'string' ? contentType : 'application/octet-stream',
      };
    } catch {
      return { contentType: 'application/octet-stream' };
    }
  }

  /**
   * Ключ → путь на диске с защитой от выхода за корень.
   *
   * Ключ приходит из БД, но полагаться на это нельзя: строка «../../.env»
   * в file_key превратила бы выдачу документа в чтение произвольного файла.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      this.logger.error({ key }, 'Ключ объекта уводит за пределы хранилища');
      throw new Error('Некорректный ключ объекта');
    }
    return path;
  }
}
