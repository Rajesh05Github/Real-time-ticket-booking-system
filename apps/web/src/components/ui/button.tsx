'use client';

import { cn } from '../../lib/cn';

import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  isLoading?: boolean;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'bg-brand-500 text-brand-ink hover:bg-brand-400 active:bg-brand-600 shadow-glow disabled:bg-surface-3 disabled:text-fg-subtle disabled:shadow-none',
  secondary:
    'bg-surface-2 text-fg border border-border-strong hover:bg-surface-3 disabled:text-fg-subtle disabled:border-border',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-2 disabled:text-fg-subtle',
  danger: 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 disabled:opacity-40',
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled || isLoading}
      aria-busy={isLoading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    >
      {isLoading && (
        <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}
