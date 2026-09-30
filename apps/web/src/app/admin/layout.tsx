'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { AdminGate } from '../../lib/auth/guards';
import { cn } from '../../lib/cn';

import type { ReactNode } from 'react';

const NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/venues', label: 'Venues' },
  { href: '/admin/events', label: 'Events' },
];

function AdminNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b border-border pb-3">
      {NAV_ITEMS.map((item) => {
        const active = item.href === '/admin' ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <AdminGate>
      <div className="space-y-6">
        <AdminNav />
        {children}
      </div>
    </AdminGate>
  );
}
