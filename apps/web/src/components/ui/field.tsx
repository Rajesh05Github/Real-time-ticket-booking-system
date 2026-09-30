import { cn } from '../../lib/cn';

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const inputBase =
  'h-10 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-brand-400 disabled:opacity-50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input className={cn(inputBase, className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea className={cn(inputBase, 'h-24 resize-y py-2', className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }): React.JSX.Element {
  return (
    <select className={cn(inputBase, 'appearance-none', className)} {...props}>
      {children}
    </select>
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps): React.JSX.Element {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg-muted">
        {label}
      </label>
      {/* Cloning aria attrs onto the child input keeps this component
          generic across Input/Select/Textarea without a switch. */}
      <div aria-describedby={describedBy} aria-invalid={Boolean(error)}>
        {children}
      </div>
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
