export * from './auth';
export * from './health';
export * from './lots';
export * from './money';
export * from './time';

/** Версия контракта между api, gateway и web. Растёт при несовместимых изменениях DTO/WS-событий. */
export const CONTRACT_VERSION = '0.0.0' as const;
