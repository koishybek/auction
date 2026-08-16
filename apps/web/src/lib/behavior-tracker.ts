import type { BehaviorSignals, PointerKind } from '@auction/shared';

/**
 * Сбор поведенческих сигналов перед ставкой (T-049, FR-11).
 *
 * Копит агрегаты, а не траекторию: сколько было движений, какой длины путь,
 * сколько указатель провёл над кнопкой. Координаты никуда не уходят и нигде не
 * хранятся — по ним восстанавливается почерк человека, а для ответа на вопрос
 * «двигался или нет» они не нужны.
 *
 * Окно короткое: интерес представляет подход к кнопке, а не вся сессия.
 */

/** Сколько миллисекунд движений учитываем. */
const WINDOW_MS = 1_000;

interface Sample {
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export class BehaviorTracker {
  private samples: Sample[] = [];
  private kind: PointerKind = 'unknown';
  private enteredAt: number | null = null;

  /** Движение указателя. Координаты живут только внутри окна и только здесь. */
  track(event: { pointerType?: string; clientX: number; clientY: number }): void {
    const at = performance.now();
    this.kind = normalizeKind(event.pointerType);
    this.samples.push({ at, x: event.clientX, y: event.clientY });
    this.samples = this.samples.filter((sample) => at - sample.at <= WINDOW_MS);
  }

  /** Указатель зашёл на кнопку — с этого момента считается прицеливание. */
  enter(): void {
    this.enteredAt = performance.now();
  }

  leave(): void {
    this.enteredAt = null;
  }

  /** Кнопку активировали с клавиатуры. */
  keyboard(): void {
    this.kind = 'keyboard';
  }

  /**
   * Слепок на момент клика.
   *
   * `trusted` берётся из самого события клика: браузер выставляет его сам, и
   * подделать из JavaScript нельзя. Путь считается по соседним точкам — сумма
   * отрезков это и есть «было движение или нет» в одном числе.
   */
  snapshot(trusted: boolean): BehaviorSignals {
    const now = performance.now();
    const recent = this.samples.filter((sample) => now - sample.at <= WINDOW_MS);

    let pathPx = 0;
    for (let index = 1; index < recent.length; index += 1) {
      const previous = recent[index - 1];
      const current = recent[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      pathPx += Math.hypot(current.x - previous.x, current.y - previous.y);
    }

    return {
      trusted,
      kind: this.kind,
      moves: recent.length,
      pathPx: Math.round(pathPx),
      dwellMs: this.enteredAt === null ? 0 : Math.round(now - this.enteredAt),
    };
  }

  reset(): void {
    this.samples = [];
    this.enteredAt = null;
    this.kind = 'unknown';
  }
}

function normalizeKind(pointerType: string | undefined): PointerKind {
  if (pointerType === 'mouse' || pointerType === 'touch' || pointerType === 'pen') {
    return pointerType;
  }
  return 'unknown';
}
