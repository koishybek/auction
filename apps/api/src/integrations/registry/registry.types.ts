/**
 * Контракт реестрового провайдера КИСИП/ЕРД (INT-02).
 *
 * Проверка арестов и обременений по ИИН/БИН собственника и кадастровому
 * номеру/VIN объекта. Реального доступа к ГИС нет (риск R-1), контракт
 * зафиксирован интерфейсом, реализация — управляемый мок.
 *
 * По ТЗ §5.1: запрос при создании лота и раз в 24 часа; HAS_RESTRICTION=true
 * переводит лот в PAUSED.
 */

export interface RegistryCheckRequest {
  /** ИИН или БИН собственника. */
  readonly iinOrBin: string;
  /** Кадастровый номер (недвижимость) или VIN (авто). */
  readonly cadastreOrVin: string;
}

/** JSON без объектов-обёрток: то, что можно честно положить в jsonb. */
export type RegistryJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly RegistryJsonValue[]
  | { readonly [key: string]: RegistryJsonValue };

export interface RegistryCheckResult {
  readonly hasRestriction: boolean;
  /** Человекочитаемые причины ограничений: арест, залог, запрет регистрации… */
  readonly restrictions: readonly string[];
  /** Сырой ответ реестра — целиком в registry_checks.payload_json для разборов. */
  readonly payload: { readonly [key: string]: RegistryJsonValue };
}

export interface RegistryProvider {
  check(request: RegistryCheckRequest): Promise<RegistryCheckResult>;
}

export const REGISTRY_PROVIDER = Symbol('REGISTRY_PROVIDER');
