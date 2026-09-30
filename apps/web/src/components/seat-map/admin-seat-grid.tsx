'use client';

import { useMemo } from 'react';

import { SeatButton } from './seat-button';
import { SeatLegend } from './seat-legend';

import type { Seat } from '../../lib/api/types';

interface AdminSeatGridProps {
  seats: Seat[];
  sectionNameById: Map<string, string>;
}

const NOOP = (): void => undefined;

/**
 * Read-only admin view built directly from the SeatButton/SeatLegend
 * primitives -- SeatMap itself always renders selection + a sticky
 * "Reserve" bar, which has no place in an admin seat inventory view, so
 * this is a small dedicated component rather than a `mode` prop grafted
 * onto the customer-facing component.
 */
export function AdminSeatGrid({ seats, sectionNameById }: AdminSeatGridProps): React.JSX.Element {
  const sections = useMemo(() => {
    const bySection = new Map<string, Seat[]>();
    for (const seat of seats) {
      const list = bySection.get(seat.sectionId) ?? [];
      list.push(seat);
      bySection.set(seat.sectionId, list);
    }
    return Array.from(bySection.entries())
      .map(([sectionId, sectionSeats]) => ({
        sectionId,
        name: sectionNameById.get(sectionId) ?? 'Unknown section',
        seats: [...sectionSeats].sort((a, b) =>
          a.seatCode.localeCompare(b.seatCode, undefined, { numeric: true }),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [seats, sectionNameById]);

  if (seats.length === 0) {
    return <p className="text-sm text-fg-muted">No seats generated for this event yet.</p>;
  }

  return (
    <div className="space-y-6">
      <SeatLegend />
      {sections.map((section) => (
        <div key={section.sectionId} className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">
            {section.name}{' '}
            <span className="font-normal text-fg-subtle">({section.seats.length} seats)</span>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {section.seats.map((seat) => (
              <SeatButton
                key={seat.id}
                seat={seat}
                selected={false}
                flash={false}
                disabled={true}
                tabIndex={-1}
                onSelect={NOOP}
                onFocus={NOOP}
                onKeyDown={NOOP}
                buttonRef={NOOP}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
