import type { Readable } from 'node:stream';

/**
 * Контракт файлового хранилища (Data Room, протоколы торгов, Акт ВЕТО).
 *
 * ТЗ и план предполагают S3-совместимое хранилище. Реквизитов бакета пока нет,
 * поэтому контракт зафиксирован интерфейсом, а рабочая реализация — локальный
 * диск. S3-провайдер подключается заменой одного провайдера в модуле: ни
 * контроллеры, ни сервисы не изменятся.
 */

export interface StoredObject {
  /** Ключ объекта в хранилище — он же lot_documents.file_key. */
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface DownloadHandle {
  readonly stream: Readable;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface StorageProvider {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>;

  get(key: string): Promise<DownloadHandle | null>;

  remove(key: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
