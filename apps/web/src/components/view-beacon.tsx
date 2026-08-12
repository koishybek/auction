'use client';

import { useEffect } from 'react';

/**
 * Отметка просмотра карточки лота (T-017).
 *
 * Стучится из браузера, а не с сервера, намеренно: страница рендерится на
 * сервере, и запрос к API оттуда шёл бы с адреса одного и того же процесса
 * Next — все посетители слились бы в одного. Заодно отсекаются обходчики
 * поисковиков: они страницу читают, но скрипты не выполняют.
 *
 * Путь относительный: в проде ingress отдаёт /api в сервис API, в разработке
 * то же самое делает rewrite в next.config. Один и тот же код на обоих контурах.
 *
 * Ошибка запроса игнорируется: счётчик интереса не повод показывать
 * посетителю сообщение о сбое.
 */
export function ViewBeacon({ lotId }: { lotId: string }) {
  useEffect(() => {
    const abort = new AbortController();

    void fetch(`/api/lots/${lotId}/view`, {
      method: 'POST',
      signal: abort.signal,
      headers: { accept: 'application/json' },
      // Ставим в очередь низкого приоритета: отметка не должна конкурировать
      // за сеть с тем, ради чего человек открыл страницу.
      priority: 'low',
    }).catch(() => undefined);

    return () => {
      abort.abort();
    };
  }, [lotId]);

  return null;
}
