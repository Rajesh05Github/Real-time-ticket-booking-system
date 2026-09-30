'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

import { cn } from '../../lib/cn';

import type { ReactNode } from 'react';

export type ToastKind = 'error' | 'success' | 'info';

export interface ToastOptions {
  kind: ToastKind;
  title: string;
  description?: string;
  /** Present when an error carries one -- shown as "ref: xxxx" so a user
   * can hand it to support (this is exactly why apps/api echoes it). */
  requestId?: string;
  durationMs?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLES: Record<ToastKind, string> = {
  error: 'border-danger/40 bg-surface-2',
  success: 'border-success/40 bg-surface-2',
  info: 'border-info/40 bg-surface-2',
};

const KIND_DOT: Record<ToastKind, string> = {
  error: 'bg-danger',
  success: 'bg-success',
  info: 'bg-info',
};

const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);
  const pausedRef = useRef(new Set<number>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions): number => {
      const id = idRef.current++;
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { ...options, id }]);

      // Errors carrying a requestId are worth reading, not auto-dismissed.
      const duration = options.durationMs ?? (options.kind === 'error' && options.requestId ? 0 : 5000);
      if (duration > 0) {
        setTimeout(() => {
          if (!pausedRef.current.has(id)) dismiss(id);
        }, duration);
      }
      return id;
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => pausedRef.current.add(t.id)}
            onMouseLeave={() => pausedRef.current.delete(t.id)}
            className={cn(
              'pointer-events-auto rounded-lg border px-4 py-3 shadow-glow backdrop-blur',
              KIND_STYLES[t.kind],
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', KIND_DOT[t.kind])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{t.title}</p>
                {t.description && <p className="mt-0.5 text-xs text-fg-muted">{t.description}</p>}
                {t.requestId && (
                  <p className="mt-1 font-mono text-[10px] text-fg-subtle">ref: {t.requestId}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="shrink-0 text-fg-subtle hover:text-fg"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used within <ToastProvider>.');
  return ctx;
}
