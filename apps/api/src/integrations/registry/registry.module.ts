import { Module } from '@nestjs/common';

import { RegistryMockProvider } from './registry.mock.provider';
import { REGISTRY_PROVIDER } from './registry.types';

/** Как и eGov: пока только мок, реальный адаптер появится с доступами (R-1). */
@Module({
  providers: [
    RegistryMockProvider,
    { provide: REGISTRY_PROVIDER, useExisting: RegistryMockProvider },
  ],
  exports: [REGISTRY_PROVIDER, RegistryMockProvider],
})
export class RegistryModule {}
