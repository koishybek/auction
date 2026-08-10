import { Module } from '@nestjs/common';

import { EgovMockProvider } from './egov.mock.provider';
import { EGOV_PROVIDER } from './egov.types';

/**
 * Пока существует только мок: доступов к реальному eGov нет (риск R-1).
 * Когда появятся — здесь добавится выбор реализации по env, интерфейс
 * и потребители не изменятся.
 */
@Module({
  providers: [EgovMockProvider, { provide: EGOV_PROVIDER, useExisting: EgovMockProvider }],
  exports: [EGOV_PROVIDER, EgovMockProvider],
})
export class EgovModule {}
