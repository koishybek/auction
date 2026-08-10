import { describe, expect, it } from 'vitest';

import { TimeService } from './time.service';

const time = new TimeService();

describe('TimeService', () => {
  it('монотонное время не уменьшается', () => {
    // Прыжок назад посреди торгов воскресил бы уже завершённый аукцион.
    let previous = time.monotonicMs();
    for (let i = 0; i < 5000; i += 1) {
      const current = time.monotonicMs();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('монотонное время идёт вперёд, а не стоит', () => {
    const start = time.monotonicMs();
    const deadline = Date.now() + 30;
    while (Date.now() < deadline) {
      /* ждём, не усыпляя поток */
    }
    expect(time.monotonicMs()).toBeGreaterThan(start);
  });

  it('монотонное время близко к стенным часам', () => {
    // Оно тоже отсчитывается от эпохи, иначе dashboards и логи не сойдутся.
    const report = time.now();
    expect(Math.abs(report.monotonicMs - report.serverTs)).toBeLessThan(1000);
  });

  it('отчёт заполнен целиком и согласован', () => {
    const report = time.now();
    expect(Number.isInteger(report.serverTs)).toBe(true);
    expect(Number.isInteger(report.monotonicMs)).toBe(true);
    expect(Number.isInteger(report.uptimeSec)).toBe(true);
    expect(report.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(new Date(report.iso).getTime()).toBe(report.serverTs);
    expect(report.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('несколько отчётов подряд не идут назад по монотонному времени', () => {
    const reports = Array.from({ length: 200 }, () => time.now());
    for (let i = 1; i < reports.length; i += 1) {
      expect(reports[i]?.monotonicMs).toBeGreaterThanOrEqual(reports[i - 1]?.monotonicMs ?? 0);
    }
  });
});
