import { Module } from '@nestjs/common';

import { LocalStorageProvider } from './local-storage.provider';
import { STORAGE_PROVIDER } from './storage.types';

/**
 * Пока только локальный диск: реквизитов S3 нет. Когда появятся — здесь
 * добавится выбор провайдера по env, потребители не изменятся.
 */
@Module({
  providers: [
    LocalStorageProvider,
    { provide: STORAGE_PROVIDER, useExisting: LocalStorageProvider },
  ],
  exports: [STORAGE_PROVIDER, LocalStorageProvider],
})
export class StorageModule {}
