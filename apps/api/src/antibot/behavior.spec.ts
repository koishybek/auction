import type { BehaviorSignals } from '@auction/shared';
import { describe, expect, it } from 'vitest';

import { assessBehavior } from './behavior';

/**
 * Поведенческая эвристика (T-049, FR-11).
 *
 * Здесь проверяется правило, по которому живому человеку могут отказать в
 * ставке. Цена ошибки несимметрична: пропущенный автомат поднимает цену на
 * шаг, а отказанный человек теряет лот. Поэтому в списке ниже больше случаев
 * «это человек», чем «это бот».
 */
function signals(over: Partial<BehaviorSignals> = {}): BehaviorSignals {
  return { trusted: true, kind: 'mouse', moves: 25, pathPx: 400, dwellMs: 300, ...over };
}

describe('T-049: поведенческая эвристика', () => {
  it('живой клик мышью проходит', () => {
    expect(assessBehavior(signals()).verdict).toBe('HUMAN');
  });

  it('DoD: клик из кода страницы требует проверки', () => {
    // dispatchEvent из консоли — ровно сценарий ТЗ §3.2. Браузер помечает
    // такое событие как недоверенное, и подделать признак из JavaScript нельзя.
    const assessment = assessBehavior(signals({ trusted: false }));
    expect(assessment.verdict).toBe('CHALLENGE');
    expect(assessment.reasons).toEqual(['UNTRUSTED_EVENT']);
  });

  it('тап по экрану телефона — человек, хотя движений нет', () => {
    // У тапа траектории не бывает вовсе. Правило «нет движения — значит бот»
    // отправило бы на капчу всех мобильных участников.
    const tap = signals({ kind: 'touch', moves: 0, pathPx: 0, dwellMs: 0 });
    expect(assessBehavior(tap).verdict).toBe('HUMAN');
  });

  it('клавиатура проходит всегда', () => {
    // Требование доступности: человек без мыши участвует наравне со всеми.
    const keyboard = signals({ kind: 'keyboard', moves: 0, pathPx: 0, dwellMs: 0 });
    expect(assessBehavior(keyboard).verdict).toBe('HUMAN');
  });

  it('короткое движение трекпадом не считается ботом', () => {
    expect(assessBehavior(signals({ moves: 6, pathPx: 9, dwellMs: 220 })).verdict).toBe('HUMAN');
  });

  it('доверенный клик мышью без движения всё равно человек', () => {
    // Мышь, дошедшая до кнопки одним прыжком, даёт ноль пройденного пути.
    // Отказывать по этому признаку значит отнимать лот у живого участника —
    // порогов, проверенных боевой статистикой, у нас пока нет.
    const assessment = assessBehavior(signals({ moves: 0, pathPx: 0, dwellMs: 0 }));
    expect(assessment.verdict).toBe('HUMAN');
    // Наблюдения при этом собираются: по ним будут настраиваться пороги.
    expect(assessment.reasons).toContain('FEW_POINTER_MOVES');
    expect(assessment.reasons).toContain('FAST_CLICK');
  });

  it('быстрый клик отмечается, но не наказывается', () => {
    const assessment = assessBehavior(signals({ dwellMs: 0 }));
    expect(assessment.verdict).toBe('HUMAN');
    expect(assessment.reasons).toEqual(['FAST_CLICK']);
  });

  it('клиент без сигналов не наказывается', () => {
    // Требование сигналов било бы по честным не-браузерным клиентам —
    // мобильному приложению, нагрузочному стенду, — и ничего не давало бы
    // против самописного бота: тот пришлёт любые цифры, какие попросим.
    const assessment = assessBehavior(null);
    expect(assessment.verdict).toBe('HUMAN');
    expect(assessment.reasons).toEqual(['NO_SIGNALS']);
  });
});
