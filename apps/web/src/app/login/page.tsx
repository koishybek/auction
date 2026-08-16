import type { Metadata } from 'next';

import { LoginPanel } from './login-panel';

export const metadata: Metadata = {
  title: 'Вход',
  robots: { index: false, follow: false },
};

/**
 * Вход (T-039).
 *
 * Настоящий вход — через eGov Digital ID (INT-01), и здесь работает его мок:
 * до подключения к государственной системе кто-то должен сыграть роль
 * гражданина со смартфоном. Сервер отдаёт сессию httpOnly-кукой, поэтому на
 * этой странице нет ни одной строчки, которая держала бы токен.
 */
export default function LoginPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="mb-4 font-serif text-4xl">Вход</h1>
      <p className="mb-12 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
        Пока eGov Digital ID не подключён, вход эмулируется. Верификация нужна для денег: без неё
        нельзя ни внести задаток, ни сделать ставку.
      </p>
      <LoginPanel />
    </main>
  );
}
