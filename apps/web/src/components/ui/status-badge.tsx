import { cn } from '../../lib/cn';

/**
 * One component for every status enum in this app, so PENDING/RESERVED/
 * etc. read consistently everywhere instead of each page inventing its
 * own color mapping. Every key across every enum this app uses is listed
 * explicitly (not a generic "green=good, red=bad" heuristic) because a
 * few statuses share a word but mean different things (e.g. a CANCELLED
 * reservation vs. a CANCELLED ticket are both "the customer/system ended
 * this," fine to share styling; DRAFT vs PENDING are visually distinct
 * because one is neutral/admin-only and the other is customer-facing
 * "waiting on something").
 */
type Status =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'UNPUBLISHED'
  | 'CANCELLED'
  | 'AVAILABLE'
  | 'RESERVED'
  | 'SOLD'
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'ACTIVE'
  | 'RELEASED'
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'REFUND_PENDING'
  | 'SUCCEEDED'
  | 'ISSUED';

const STYLES: Record<Status, string> = {
  DRAFT: 'bg-surface-3 text-fg-muted border-border-strong',
  PUBLISHED: 'bg-success/10 text-success border-success/30',
  UNPUBLISHED: 'bg-surface-3 text-fg-muted border-border-strong',
  CANCELLED: 'bg-surface-3 text-fg-subtle border-border',
  AVAILABLE: 'bg-success/10 text-success border-success/30',
  RESERVED: 'bg-warning/10 text-warning border-warning/30',
  SOLD: 'bg-surface-3 text-fg-subtle border-border',
  PENDING_PAYMENT: 'bg-warning/10 text-warning border-warning/30',
  CONFIRMED: 'bg-success/10 text-success border-success/30',
  EXPIRED: 'bg-danger/10 text-danger border-danger/30',
  ACTIVE: 'bg-success/10 text-success border-success/30',
  RELEASED: 'bg-surface-3 text-fg-subtle border-border',
  PENDING: 'bg-warning/10 text-warning border-warning/30',
  PAID: 'bg-success/10 text-success border-success/30',
  FAILED: 'bg-danger/10 text-danger border-danger/30',
  REFUNDED: 'bg-info/10 text-info border-info/30',
  REFUND_PENDING: 'bg-info/10 text-info border-info/30',
  SUCCEEDED: 'bg-success/10 text-success border-success/30',
  ISSUED: 'bg-success/10 text-success border-success/30',
};

const LABELS: Partial<Record<Status, string>> = {
  PENDING_PAYMENT: 'Pending payment',
  REFUND_PENDING: 'Refund pending',
};

export function StatusBadge({ value }: { value: string }): React.JSX.Element {
  const status = value as Status;
  const style = STYLES[status] ?? 'bg-surface-3 text-fg-muted border-border';
  const label = LABELS[status] ?? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
        style,
      )}
    >
      {label}
    </span>
  );
}
