import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Цифровой гибридный аукцион скоростных продаж',
  description:
    'Платформа скоростных торгов: шаг ставки +3 %, таймер 50 секунд, задаток 10 %, анонимные участники.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
