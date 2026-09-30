'use client';

import { AuthGate } from '../../lib/auth/guards';

import type { ReactNode } from 'react';

export default function TicketsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <AuthGate>{children}</AuthGate>;
}
