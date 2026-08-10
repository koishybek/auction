import { createHash, randomBytes } from 'node:crypto';

import type { AccessTokenPayload, UserRole } from '@auction/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { Env } from '../config/env.schema';

/**
 * Выпуск и проверка токенов.
 *
 * Access — подписанный JWT, живёт коротко и не проверяется по базе на каждый
 * запрос (иначе 50 000 подключений превратят БД в узкое место). Отозвать его
 * нельзя, поэтому TTL маленький.
 *
 * Refresh — случайная строка, а не JWT. Он проверяется по БД всегда, значит
 * подписывать нечего; зато хранится только его хэш, и утечка дампа не даёт входа.
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.accessTtlSeconds = Math.floor(
      parseDuration(config.get('JWT_ACCESS_TTL', { infer: true })) / 1000,
    );
    this.refreshTtlMs = parseDuration(config.get('JWT_REFRESH_TTL', { infer: true }));
  }

  /**
   * expiresIn задаём числом секунд, а не строкой «15m».
   *
   * Со строкой её разбирал бы пакет `ms` внутри jsonwebtoken, а клиенту мы
   * сообщаем срок из своего parseDuration — два парсера на одно значение,
   * и однажды они разойдутся. Здесь источник один.
   */
  signAccess(payload: AccessTokenPayload): string {
    return this.jwt.sign(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
    });
  }

  /** Бросает, если токен просрочен, подделан или подписан другим секретом. */
  verifyAccess(token: string): AccessTokenPayload {
    const decoded = this.jwt.verify<{ sub: string; roles: UserRole[]; sid: string }>(token, {
      secret: this.accessSecret,
    });
    return { sub: decoded.sub, roles: decoded.roles, sid: decoded.sid };
  }

  /** 256 бит энтропии — перебор бессмысленен, подписывать не нужно. */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Хэш для хранения. Без соли и намеренно: токен и так случайный на 256 бит,
   * словарной атаки по нему не бывает, а детерминированный хэш нужен для поиска
   * записи по предъявленному токену за один индексный запрос.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  accessTtlSec(): number {
    return this.accessTtlSeconds;
  }

  refreshExpiresAt(from: Date): Date {
    return new Date(from.getTime() + this.refreshTtlMs);
  }
}

/**
 * Разбор «15m», «30d», «3600s» в миллисекунды.
 *
 * Своя функция вместо библиотеки: формат нужен ровно один, а лишняя зависимость
 * в контуре авторизации — лишняя поверхность атаки.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Некорректная длительность «${value}». Ожидается вид 15m, 30d, 3600s.`);
  }
  const amount = Number.parseInt(match[1] ?? '0', 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multipliers[unit ?? 'ms'] ?? 1);
}
