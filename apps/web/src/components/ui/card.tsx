import { cn } from '../../lib/cn';

import type { HTMLAttributes } from 'react';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface transition-colors',
        'hover:border-border-strong',
        className,
      )}
      {...props}
    />
  );
}
