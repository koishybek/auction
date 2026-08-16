export * from './antibot';
export * from './auction';
export * from './auth';
export * from './deposits';
export * from './health';
export * from './lots';
export * from './money';
export * from './partners';
export * from './ref-bonus';
export * from './seller';
export * from './time';
export * from './ws';

/** Версия контракта между api, gateway и web. Растёт при несовместимых изменениях DTO/WS-событий. */
export const CONTRACT_VERSION = '0.0.0' as const;
