'use client';

import { useEffect, useRef } from 'react';

import type { ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * A native <dialog> element -- not a hand-rolled div-with-a-backdrop, and
 * not a Radix dependency for the one modal this app needs. <dialog>
 * gives focus trapping, Escape-to-close, and backdrop semantics for
 * free.
 */
export function Dialog({ open, onClose, title, children }: DialogProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-full max-w-md rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-canvas/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button type="button" onClick={onClose} className="text-fg-subtle hover:text-fg" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
