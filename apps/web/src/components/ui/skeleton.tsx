import { cn } from '../../lib/cn';

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('animate-pulse rounded-md bg-surface-3', className)} />;
}
