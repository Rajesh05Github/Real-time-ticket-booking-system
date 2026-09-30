import { NavBar } from '../components/nav-bar';

import { Providers } from './providers';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'FLASHSALE',
  description: 'Event ticket booking, built to teach distributed systems.',
};

// Root layout stays a Server Component -- Providers (below) is the one
// client boundary, kept as small and as low in the tree as it can be.
export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <Providers>
          <NavBar />
          <main className="mx-auto min-h-[calc(100vh-4rem)] max-w-6xl px-4 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
