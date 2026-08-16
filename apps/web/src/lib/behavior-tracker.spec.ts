import { describe, expect, it } from 'vitest';

import { BehaviorTracker } from './behavior-tracker';

/**
 * Сбор сигналов клика (T-049, FR-11).
 *
 * Проверяется главное свойство: у живого движения агрегаты ненулевые, у
 * синтетического клика — нули. Именно на этой разнице стоит эвристика
 * сервера, и если сборщик молчит, отказ получит живой человек.
 */
describe('T-049: сборщик поведения', () => {
  it('движение мышью даёт ненулевой путь', () => {
    const tracker = new BehaviorTracker();
    for (let step = 0; step < 12; step += 1) {
      tracker.track({ pointerType: 'mouse', clientX: 100 + step * 7, clientY: 200 + step * 3 });
    }
    tracker.enter();

    const snapshot = tracker.snapshot(true);
    expect(snapshot.kind).toBe('mouse');
    expect(snapshot.moves).toBe(12);
    expect(snapshot.pathPx).toBeGreaterThan(50);
  });

  it('без единого движения агрегаты нулевые', () => {
    // Ровно то, что видит сервер при dispatchEvent из консоли.
    const snapshot = new BehaviorTracker().snapshot(true);
    expect(snapshot.moves).toBe(0);
    expect(snapshot.pathPx).toBe(0);
    expect(snapshot.dwellMs).toBe(0);
    expect(snapshot.kind).toBe('unknown');
  });

  it('клавиатура помечается явно', () => {
    const tracker = new BehaviorTracker();
    tracker.keyboard();
    // Человек без мыши обязан участвовать наравне: сервер пропускает такой
    // клик без вопросов, и метка нужна именно для этого.
    expect(tracker.snapshot(true).kind).toBe('keyboard');
  });

  it('сброс очищает накопленное', () => {
    const tracker = new BehaviorTracker();
    tracker.track({ pointerType: 'mouse', clientX: 0, clientY: 0 });
    tracker.track({ pointerType: 'mouse', clientX: 50, clientY: 50 });
    tracker.enter();
    tracker.reset();

    const snapshot = tracker.snapshot(true);
    expect(snapshot.moves).toBe(0);
    expect(snapshot.dwellMs).toBe(0);
  });
});
