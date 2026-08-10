import { describe, expect, it } from 'vitest';

import { maskIin } from './users.service';

describe('maskIin', () => {
  it('оставляет дату рождения, скрывает остальное', () => {
    expect(maskIin('900101300123')).toBe('900101******');
  });

  it('нестандартную длину скрывает целиком — ничего не угадываем', () => {
    expect(maskIin('12345')).toBe('*****');
    expect(maskIin('')).toBe('');
  });
});
