/**
 * Контракт ручек здоровья. Живёт здесь, а не в api, потому что это граница
 * между приложениями: api его реализует, web потребляет. Одна правка типа —
 * и обе стороны перестают собираться, если разошлись.
 */

export type DependencyStatus = 'up' | 'down';

export interface DependencyReport {
  readonly status: DependencyStatus;
  /** null, если зависимость недоступна и мерить нечего. */
  readonly latencyMs: number | null;
  readonly error?: string;
}

/** Ответ `GET /health` — процесс жив. Зависимости намеренно не проверяются. */
export interface LivenessReport {
  readonly status: 'ok';
  readonly uptimeSec: number;
}

/** Ответ `GET /health/ready` — 200 при status: 'up', 503 при 'down'. */
export interface ReadinessReport {
  readonly status: DependencyStatus;
  readonly dependencies: Readonly<Record<string, DependencyReport>>;
}
