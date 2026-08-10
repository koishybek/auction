import { Injectable } from '@nestjs/common';

import type { RegistryCheckRequest, RegistryCheckResult, RegistryProvider } from './registry.types';

/**
 * Мок КИСИП/ЕРД с управляемыми ответами.
 *
 * По умолчанию ограничений нет. Тесты и dev-сценарии задают их точечно:
 * setRestriction() — по конкретному объекту. Плюс конвенция для ручной
 * проверки без кода: кадастр/VIN, начинающийся с «ARREST», всегда
 * возвращает ограничение.
 */
@Injectable()
export class RegistryMockProvider implements RegistryProvider {
  private readonly restrictions = new Map<string, readonly string[]>();

  check(request: RegistryCheckRequest): Promise<RegistryCheckResult> {
    const key = normalize(request.cadastreOrVin);
    const fromMap = this.restrictions.get(key);
    const byConvention = key.startsWith('ARREST') ? ['Арест по конвенции мока'] : null;

    const found = fromMap ?? byConvention ?? [];
    return Promise.resolve({
      hasRestriction: found.length > 0,
      restrictions: found,
      payload: {
        provider: 'mock',
        request: { iinOrBin: request.iinOrBin, cadastreOrVin: request.cadastreOrVin },
        matched: found,
      },
    });
  }

  /** Задать ограничения по объекту. Пустой массив — снять. */
  setRestriction(cadastreOrVin: string, restrictions: readonly string[]): void {
    const key = normalize(cadastreOrVin);
    if (restrictions.length === 0) {
      this.restrictions.delete(key);
    } else {
      this.restrictions.set(key, restrictions);
    }
  }

  reset(): void {
    this.restrictions.clear();
  }
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}
