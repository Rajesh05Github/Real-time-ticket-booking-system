'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from '../../lib/auth/auth-context';

import type { ReactNode } from 'react';

/**
 * Route group `(auth)` -- doesn't appear in the URL (still `/login`,
 * `/register`, `/verify`). Redirects an already-authenticated visitor
 * away, the mirror image of `<AuthGate>`: there's nothing useful for a
 * logged-in user to do on a login page.
 */
export default function AuthLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/');
    }
  }, [status, router]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-12">
      <div className="w-full rounded-xl border border-border bg-surface p-8">{children}</div>
    </div>
  );
}
