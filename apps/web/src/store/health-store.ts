'use client';

import type { ReadinessReport } from '@auction/shared';
import { create } from 'zustand';

/**
 * Клиентский стор состояния бэкенда.
 *
 * Начальное значение приезжает с сервера (SSR), дальше обновляется на клиенте.
 * Тот же приём понадобится в аукционном зале: снимок состояния торгов приходит
 * с сервера, дальше его двигают WS-события.
 */

interface HealthState {
  readonly report: ReadinessReport | null;
  readonly error: string | null;
  readonly checking: boolean;
  readonly checkedAt: string | null;
  hydrate: (report: ReadinessReport | null, error: string | null) => void;
  refresh: () => Promise<void>;
}

export const useHealthStore = create<HealthState>((set) => ({
  report: null,
  error: null,
  checking: false,
  checkedAt: null,

  hydrate: (report, error) => {
    set({ report, error, checkedAt: new Date().toISOString() });
  },

  refresh: async () => {
    set({ checking: true });
    try {
      // Через собственный роут: адрес API остаётся на сервере и не попадает в бандл.
      const response = await fetch('/api/readiness', { cache: 'no-store' });
      const payload: unknown = await response.json();
      set({
        report: payload as ReadinessReport,
        error: null,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      set({
        report: null,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    } finally {
      set({ checking: false });
    }
  },
}));
