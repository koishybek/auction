import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * Три роли, одна семья.
 *
 * Plex выбран не за нейтральность: у него инженерное происхождение и полная
 * кириллица. Serif — только заголовок лота и цена, Mono — все числа и коды,
 * Sans — интерфейс. Смешивать роли нельзя: цена в Sans перестаёт быть данными.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexSerif = IBM_Plex_Serif({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500'],
  variable: '--font-plex-serif',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://auction.example.kz'),
  title: {
    default: 'Аукцион скоростных продаж — недвижимость и транспорт',
    template: '%s — Аукцион скоростных продаж',
  },
  description:
    'Открытые торги недвижимостью и транспортом в Казахстане. Шаг ставки +3 %, пятьдесят секунд тишины завершают торги, участники анонимны.',
  openGraph: {
    type: 'website',
    locale: 'ru_KZ',
    siteName: 'Аукцион скоростных продаж',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable}`}>
      <body className="min-h-screen antialiased">
        <header className="border-b border-[var(--color-rule)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
            <Link href="/" className="group flex items-baseline gap-3">
              <span className="font-serif text-lg leading-none">Аукцион</span>
              <span className="eyebrow group-hover:text-[var(--color-signal)]">
                скоростных продаж
              </span>
            </Link>
            <nav className="flex items-center gap-6">
              <Link
                href="/"
                className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-paper)]"
              >
                Лоты
              </Link>
              <Link
                href="/seller"
                className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-paper)]"
              >
                Кабинет продавца
              </Link>
              <Link
                href="/partner"
                className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-paper)]"
              >
                Кабинет партнёра
              </Link>
              <Link
                href="/login"
                className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-paper)]"
              >
                Вход
              </Link>
              <Link
                href="/status"
                className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-paper)]"
              >
                Состояние
              </Link>
            </nav>
          </div>
        </header>

        {children}

        <footer className="mt-24 border-t border-[var(--color-rule)]">
          <div className="mx-auto max-w-6xl px-6 py-8">
            <p className="text-xs text-[var(--color-muted)]">
              Торги ведутся по регламенту Smart Hammer: шаг +3 %, пятьдесят секунд тишины завершают
              лот. Задаток 10 % возвращается проигравшим в течение 24 часов.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
