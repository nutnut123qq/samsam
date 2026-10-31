import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Sâm Sâm — hệ thống nội bộ' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
