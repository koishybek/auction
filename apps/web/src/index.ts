import { CONTRACT_VERSION } from '@auction/shared';

/**
 * Заглушка. Настоящий каркас Next.js (SSR, Tailwind, Zustand, типизированный
 * API-клиент) приходит в T-006 и заменит этот файл на app-роутер.
 * Существует только чтобы `pnpm build` собирал приложение из чистого клона (DoD T-001).
 */
export const contractVersion: string = CONTRACT_VERSION;
