import { describe, expect, it } from 'vitest';

import { RUNNER_UP_ATTEMPTS, shouldAskAgain } from './runner-up-poll';

/**
 * Опрос права участника №2 (FR-14).
 *
 * Дефект, из-за которого это появилось, ловится только временем: событие о
 * закрытии торгов уходит из Redis раньше, чем воркер запишет метку участника
 * №2 в PostgreSQL. Клиент, спросивший один раз, получал «не предлагали» и
 * терял выбор до перезагрузки. На машине разработчика порядок обратный —
 * поймал прогон CI, где сервер оказался медленнее браузера.
 */
describe('переспрос права участника №2', () => {
  it('получив предложение, больше не спрашиваем', () => {
    expect(shouldAskAgain({ offered: true }, 1)).toBe(false);
    expect(shouldAskAgain({ offered: true }, RUNNER_UP_ATTEMPTS - 1)).toBe(false);
  });

  it('пока ответ отрицательный — спрашиваем снова, но не бесконечно', () => {
    expect(shouldAskAgain({ offered: false }, 1)).toBe(true);
    expect(shouldAskAgain({ offered: false }, RUNNER_UP_ATTEMPTS - 1)).toBe(true);
    // Участник №2 на лоте один: если предложения нет, оно уже не появится.
    expect(shouldAskAgain({ offered: false }, RUNNER_UP_ATTEMPTS)).toBe(false);
  });

  it('отсутствие ответа — не отказ', () => {
    // 401 у гостя или обрыв сети: «нет ответа» и «не предлагали» — разные вещи.
    expect(shouldAskAgain(null, 1)).toBe(true);
    expect(shouldAskAgain(null, RUNNER_UP_ATTEMPTS)).toBe(false);
  });
});
