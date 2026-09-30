'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useAuth } from '../lib/auth/auth-context';

import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

export function NavBar(): React.JSX.Element {
  const { user, status, logout } = useAuth();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-canvas/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-bold tracking-tight text-fg">
            FLASH<span className="text-brand-400">SALE</span>
          </Link>
          <nav className="hidden items-center gap-4 text-sm text-fg-muted sm:flex">
            <Link href="/events" className="hover:text-fg">
              Events
            </Link>
            {status === 'authenticated' && (
              <>
                <Link href="/reservations" className="hover:text-fg">
                  Reservations
                </Link>
                <Link href="/orders" className="hover:text-fg">
                  Orders
                </Link>
                <Link href="/tickets" className="hover:text-fg">
                  Tickets
                </Link>
                <Link href="/notifications" className="hover:text-fg">
                  Notifications
                </Link>
              </>
            )}
            {status === 'authenticated' && user?.role === 'ADMIN' && (
              <Link
                href="/admin"
                className="rounded-full border border-brand-500/40 px-2.5 py-0.5 text-brand-300 hover:border-brand-400"
              >
                Admin
              </Link>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {status === 'loading' ? (
            <Skeleton className="h-8 w-24" />
          ) : status === 'authenticated' ? (
            <>
              <span className="hidden text-sm text-fg-muted sm:inline">{user?.email}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void logout().then(() => router.push('/'));
                }}
              >
                Log out
              </Button>
            </>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm">
                  Log in
                </Button>
              </Link>
              <Link href="/register">
                <Button variant="primary" size="sm">
                  Sign up
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
