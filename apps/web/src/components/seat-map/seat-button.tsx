'use client';

import { cn } from '../../lib/cn';

import type { SeatAvailabilitySeat } from '../../lib/api/types';

interface SeatButtonProps {
  seat: SeatAvailabilitySeat;
  selected: boolean;
  flash: boolean;
  disabled: boolean;
  tabIndex: number;
  onSelect: (seatId: string) => void;
  onFocus: (seatId: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}

const STATUS_CLASSES: Record<SeatAvailabilitySeat['status'], string> = {
  AVAILABLE: 'bg-seat-available ring-1 ring-inset ring-seat-available-ring text-fg-muted hover:bg-surface-3 hover:text-fg',
  RESERVED: 'bg-seat-reserved text-seat-reserved-fg cursor-not-allowed',
  SOLD: 'bg-seat-sold text-seat-sold-fg cursor-not-allowed',
};

export function SeatButton({
  seat,
  selected,
  flash,
  disabled,
  tabIndex,
  onSelect,
  onFocus,
  onKeyDown,
  buttonRef,
}: SeatButtonProps): React.JSX.Element {
  const isPickable = seat.status === 'AVAILABLE' && !disabled;

  return (
    <button
      ref={buttonRef}
      type="button"
      role="gridcell"
      tabIndex={tabIndex}
      disabled={!isPickable}
      aria-pressed={selected}
      aria-label={`Seat ${seat.seatCode}, ${seat.status.toLowerCase()}${selected ? ', selected' : ''}`}
      title={`${seat.seatCode} -- ${seat.status.toLowerCase()}`}
      onClick={() => onSelect(seat.id)}
      onFocus={() => onFocus(seat.id)}
      onKeyDown={onKeyDown}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-md text-[10px] font-medium transition-colors',
        selected
          ? 'bg-seat-selected text-brand-ink shadow-glow'
          : STATUS_CLASSES[seat.status],
        flash && 'animate-pulse bg-warning/70 text-brand-ink',
      )}
    >
      {seat.seatCode}
    </button>
  );
}
