import type { LotStatusValue } from '@auction/shared';

/**
 * Храповик фаз — подпись этого интерфейса.
 *
 * Три сегмента, потому что фаз ровно три и они упорядочены: нумерация здесь
 * несёт информацию, а не украшает. Заполненные сегменты — пройденный путь,
 * третий в Фазе III живой: торги идут прямо сейчас.
 */

const PHASE_INDEX: Partial<Record<LotStatusValue, number>> = {
  PHASE_I: 1,
  PHASE_II: 2,
  PHASE_III: 3,
  FINISHED: 3,
};

export function phaseLabel(status: LotStatusValue): string {
  switch (status) {
    case 'PHASE_I':
      return 'Фаза I · размещение';
    case 'PHASE_II':
      return 'Фаза II · показы и задатки';
    case 'PHASE_III':
      return 'Фаза III · торги идут';
    case 'FINISHED':
      return 'Торги завершены';
    default:
      return 'Не в торгах';
  }
}

export function PhaseRatchet({
  status,
  size = 'sm',
}: {
  status: LotStatusValue;
  size?: 'sm' | 'lg';
}) {
  const filled = PHASE_INDEX[status] ?? 0;
  const isLive = status === 'PHASE_III';
  const isDone = status === 'FINISHED';

  const bar = size === 'lg' ? 'h-6 w-3' : 'h-3.5 w-1.5';
  const gap = size === 'lg' ? 'gap-1.5' : 'gap-1';

  return (
    <span
      className={`inline-flex items-end ${gap}`}
      role="img"
      aria-label={phaseLabel(status)}
      title={phaseLabel(status)}
    >
      {[1, 2, 3].map((segment) => {
        const on = segment <= filled;
        const liveTip = isLive && segment === 3;
        const color = !on
          ? 'bg-[var(--color-rule)]'
          : isDone
            ? 'bg-[var(--color-muted)]'
            : liveTip
              ? 'bg-[var(--color-signal)]'
              : 'bg-[var(--color-signal-dim)]';
        return (
          <span key={segment} className={`${bar} ${color} ${liveTip ? 'live-segment' : ''}`} />
        );
      })}
    </span>
  );
}
