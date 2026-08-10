import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { TimeService } from '../../time/time.service';

import type { EgovIdentity, EgovInitResult, EgovProvider, EgovSessionState } from './egov.types';

interface MockSession {
  state: EgovSessionState;
  readonly expiresAtMs: number;
}

/** Время жизни QR-сессии. У реального eGov — минуты; здесь то же, чтобы флоу совпадал. */
const SESSION_TTL_MS = 5 * 60_000;

/**
 * Мок eGov: держит QR-сессии в памяти процесса.
 *
 * Подтверждение приходит не само — его эмулирует ручка dev-approve (вне prod)
 * или напрямую вызов approve()/deny() из тестов. Это сознательно повторяет
 * асинхронность настоящего флоу: init ≠ мгновенный вход.
 *
 * В памяти, а не в БД: сессия живёт минуты и представляет ценность только для
 * одного инстанса dev-окружения. Реальный адаптер хранит состояние на стороне eGov.
 */
@Injectable()
export class EgovMockProvider implements EgovProvider {
  private readonly logger = new Logger(EgovMockProvider.name);
  private readonly sessions = new Map<string, MockSession>();

  constructor(private readonly time: TimeService) {}

  initQr(): Promise<EgovInitResult> {
    this.evictExpired();
    const sessionId = randomUUID();
    const expiresAtMs = this.time.wallClockMs() + SESSION_TTL_MS;
    this.sessions.set(sessionId, { state: { status: 'PENDING' }, expiresAtMs });
    return Promise.resolve({
      sessionId,
      qrUrl: `egov-mock://qr/${sessionId}`,
      expiresAtMs,
    });
  }

  check(sessionId: string): Promise<EgovSessionState> {
    return Promise.resolve(this.stateOf(sessionId));
  }

  consume(sessionId: string): Promise<EgovIdentity | null> {
    const state = this.stateOf(sessionId);
    if (state.status !== 'APPROVED') {
      return Promise.resolve(null);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = { status: 'CONSUMED' };
    }
    return Promise.resolve(state.identity);
  }

  // ─── Управление моком (dev-ручка и тесты) ─────────────────────────────────

  /** Эмуляция «гражданин подтвердил в eGov Mobile». */
  approve(sessionId: string, identity: EgovIdentity): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || this.stateOf(sessionId).status !== 'PENDING') {
      return false;
    }
    session.state = { status: 'APPROVED', identity };
    this.logger.debug({ sessionId }, 'Мок eGov: сессия подтверждена');
    return true;
  }

  /** Эмуляция отказа в приложении. */
  deny(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || this.stateOf(sessionId).status !== 'PENDING') {
      return false;
    }
    session.state = { status: 'DENIED' };
    return true;
  }

  private stateOf(sessionId: string): EgovSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 'EXPIRED' };
    }
    if (session.state.status === 'PENDING' && session.expiresAtMs <= this.time.wallClockMs()) {
      session.state = { status: 'EXPIRED' };
    }
    return session.state;
  }

  /** Чтобы Map не рос бесконечно на длинной dev-сессии. */
  private evictExpired(): void {
    const now = this.time.wallClockMs();
    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs + SESSION_TTL_MS < now) {
        this.sessions.delete(id);
      }
    }
  }
}
