import type { Metadata } from 'next';

import { SellerDashboard } from './seller-dashboard';

export const metadata: Metadata = {
  title: 'Кабинет продавца',
  robots: { index: false, follow: false },
};

/**
 * Кабинет продавца (T-041, FR-15/FR-16).
 *
 * Страница клиентская целиком: сессия живёт в куке, и рендерить её на сервере
 * значило бы гонять чужую сессию через процесс Next. Данных для SEO здесь
 * нет — кабинет не индексируется.
 */
export default function SellerPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <header className="mb-12 border-b border-[var(--color-rule)] pb-8">
        <h1 className="font-serif text-4xl">Монитор прозрачности</h1>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
          Интерес к вашим лотам в цифрах: сколько раз открывали карточку, скачивали документы и
          записывались на показ. Во время торгов кабинет работает только на просмотр — ставку по
          своему лоту не принимает сервер, а не интерфейс.
        </p>
      </header>
      <SellerDashboard />
    </main>
  );
}
