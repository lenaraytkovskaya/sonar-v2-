import type { ReactNode } from 'react';
import { Inter, Manrope } from 'next/font/google';
import { ThemeProvider } from '@/components/theme-provider';
import { uk } from '@/i18n/uk';
import './globals.css';
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
});
const manrope = Manrope({
  subsets: ['latin', 'cyrillic'],
  weight: '700',
  variable: '--font-manrope',
});
export const metadata = { title: uk.appName };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk" suppressHydrationWarning>
      <body className={`${inter.variable} ${manrope.variable}`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
