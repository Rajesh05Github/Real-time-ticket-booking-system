'use client';

import { ToastProvider } from '../components/ui/toast';
import { AuthProvider } from '../lib/auth/auth-context';

import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <ToastProvider>
      <AuthProvider>{children}</AuthProvider>
    </ToastProvider>
  );
}
