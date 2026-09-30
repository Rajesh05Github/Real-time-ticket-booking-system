'use client';

import { cn } from '../lib/cn';
import { useCountdown } from '../lib/hooks/use-countdown';

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function CountdownBadge({
  expiresAt,
  onExpire,
}: {
  expiresAt: string;
  onExpire?: () => void;
}): React.JSX.Element {
  const { secondsLeft, isUrgent, isExpired } = useCountdown(expiresAt, onExpire);

  return (
    <span
      className={cn(
        'tnum inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        isExpired
          ? 'border-border-strong bg-surface-3 text-fg-subtle'
          : isUrgent
            ? 'border-danger/40 bg-danger/10 text-danger'
            : 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      {isExpired ? 'Expired' : formatClock(secondsLeft)}
    </span>
  );
}
