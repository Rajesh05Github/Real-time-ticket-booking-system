'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from './auth-context';

import type { ReactNode } from 'react';

/**
 * Client-side gates, NOT middleware.ts -- a deliberate choice, not a
 * shortcut. The session cookie is HttpOnly and the session itself lives
 * in Redis; middleware can observe the cookie's PRESENCE at best, never
 * verify it or read `role` (which appears in no readable cookie at all).
 * Real authorization is, and remains, apps/api's `requireAuth`/
 * `requireRole('ADMIN')` -- a user who forces `/admin` past this gate
 * sees a shell whose every fetch call still returns 403. These gates
 * exist purely so that shell doesn't flash empty/broken content while
 * `GET /me` is in flight, and so an unauthenticated visitor lands on
 * `/login` instead of a page full of failed requests.
 */

function FullPageSkeleton(): React.JSX.Element {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="size-8 animate-spin rounded-full border-2 border-border-strong border-t-brand-400" />
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, router, pathname]);

  if (status !== 'authenticated') {
    return <FullPageSkeleton />;
  }
  return <>{children}</>;
}

export function AdminGate({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { status, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace('/login?next=/admin');
    } else if (status === 'authenticated' && user?.role !== 'ADMIN') {
      router.replace('/');
    }
  }, [status, user, router]);

  if (status !== 'authenticated' || user?.role !== 'ADMIN') {
    return <FullPageSkeleton />;
  }
  return <>{children}</>;
}
