import { CONTRACT_VERSION } from '@auction/shared';

/**
 * Заглушка точки входа. Настоящий bootstrap NestJS (конфиг-модуль, /health,
 * pino, OpenAPI, глобальные фильтры) приходит в T-005.
 * Здесь она существует только чтобы `pnpm build` собирал приложение из чистого клона (DoD T-001).
 */
export function bootstrap(): string {
  return `@auction/api, контракт ${CONTRACT_VERSION}`;
}
