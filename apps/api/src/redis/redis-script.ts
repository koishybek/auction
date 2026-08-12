import type Redis from 'ioredis';

/**
 * Lua-скрипт, живущий в Redis по SHA.
 *
 * Почему не обычный EVAL: тело скрипта уходило бы по сети при каждом вызове.
 * Для счётчика просмотров это неважно, но тот же механизм несёт ядро ставки
 * (T-024) — там 50 000 участников бьют в один скрипт, и разница между «40 байт
 * SHA» и «килобайт исходника» на каждую ставку становится трафиком в мегабайтах.
 *
 * Redis имеет право забыть скрипт: SCRIPT FLUSH, перезапуск, переключение на
 * реплику. Поэтому NOSCRIPT — не ошибка, а сигнал загрузить тело заново; ровно
 * один раз, иначе сломанный скрипт ушёл бы в бесконечный цикл перезагрузки.
 */
export class RedisScript {
  private sha: string | null = null;

  constructor(
    private readonly client: Redis,
    readonly source: string,
  ) {}

  /**
   * Возвращает `unknown`: Redis отвечает плоскими массивами и числами, а
   * разбор — дело вызывающего, который знает контракт своего скрипта.
   */
  run(keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
    return this.exec(keys, args, true);
  }

  private async exec(
    keys: readonly string[],
    args: readonly (string | number)[],
    mayReload: boolean,
  ): Promise<unknown> {
    this.sha ??= await this.load();

    try {
      return await this.client.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (mayReload && isNoScript(error)) {
        this.sha = null;
        return this.exec(keys, args, false);
      }
      throw error;
    }
  }

  private async load(): Promise<string> {
    const sha: unknown = await this.client.script('LOAD', this.source);
    if (typeof sha !== 'string') {
      throw new Error(`SCRIPT LOAD вернул не строку: ${String(sha)}`);
    }
    return sha;
  }
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}

/**
 * HGETALL отдаёт плоский массив [поле, значение, поле, значение, ...].
 * Значения приходят строками — Redis не хранит чисел, он хранит байты.
 */
export function parseFieldCounters(raw: unknown): Map<string, number> {
  const result = new Map<string, number>();
  // Array.isArray сужает unknown до any[], а any в проекте запрещён (CLAUDE.md §4.1).
  const items: readonly unknown[] = Array.isArray(raw) ? (raw as readonly unknown[]) : [];

  for (let i = 0; i + 1 < items.length; i += 2) {
    const field = items[i];
    const value = Number(items[i + 1]);
    if (typeof field === 'string' && Number.isSafeInteger(value) && value > 0) {
      result.set(field, value);
    }
  }
  return result;
}
