import { Module } from '@nestjs/common';

import { BankMockProvider } from './bank.mock.provider';
import { BANK_PROVIDER } from './bank.types';

/**
 * Банковский адаптер (ОВ-3).
 *
 * Тот же приём, что у eGov, реестра и уведомлений: потребители зависят только
 * от интерфейса, реальный банк подключается заменой провайдера. Договора с
 * банком нет, и до него мок — единственная честная реализация.
 */
@Module({
  providers: [BankMockProvider, { provide: BANK_PROVIDER, useExisting: BankMockProvider }],
  exports: [BANK_PROVIDER, BankMockProvider],
})
export class BankProviderModule {}
