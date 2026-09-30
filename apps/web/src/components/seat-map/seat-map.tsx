'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSeatAvailability } from '../../lib/api/endpoints/seats';
import { isApiError } from '../../lib/api/errors';
import { formatMinor } from '../../lib/api/money';
import { useEventLive } from '../../lib/hooks/use-event-live';
import { Button } from '../ui/button';

import { SeatButton } from './seat-button';
import { SeatLegend } from './seat-legend';

import type { SeatAvailability, SeatAvailabilitySeat } from '../../lib/api/types';

/** Above this many seats, rendering one <button> per seat would hang the
 * tab (seat generation allows up to 100,000 seats per assignment) -- fall
 * back to a plain quantity stepper + "best available" pick instead of a
 * visual grid. The seeded demo event (40 seats) never hits this path. */
const GRID_RENDER_LIMIT = 1500;

interface SeatMapProps {
  eventId: string;
  initialAvailability: SeatAvailability;
  maxSeats: number;
  onReserve: (seatIds: string[]) => Promise<void>;
  isReserving: boolean;
}

export function SeatMap({
  eventId,
  initialAvailability,
  maxSeats,
  onReserve,
  isReserving,
}: SeatMapProps): React.JSX.Element {
  const [availability, setAvailability] = useState(initialAvailability);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());
  const [quantity, setQuantity] = useState(1);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  const allSeats = useMemo(
    () => availability.sections.flatMap((section) => section.seats),
    [availability],
  );
  const seatById = useMemo(() => new Map(allSeats.map((seat) => [seat.id, seat])), [allSeats]);

  const useGrid = availability.totalSeats <= GRID_RENDER_LIMIT;

  // Live seat updates (apps/worker's live-seat consumer -> the event's
  // Pub/Sub channel -> this tab's shared socket): patch just the changed
  // seats and their section counts in place, and drop any now-taken seat
  // from the current selection with the same amber flash a 409 conflict
  // produces -- so a user sees a seat go before they try to reserve it.
  useEventLive(eventId, (message) => {
    if (message.type !== 'seatStatus' || message.seats.length === 0) return;
    const changes = new Map(message.seats.map((seat) => [seat.id, seat.status]));

    setAvailability((prev) => {
      let availableDelta = 0;
      const sections = prev.sections.map((section) => {
        let sectionDelta = 0;
        const seats = section.seats.map((seat) => {
          const next = changes.get(seat.id);
          if (!next || next === seat.status) return seat;
          if (seat.status === 'AVAILABLE') sectionDelta -= 1;
          if (next === 'AVAILABLE') sectionDelta += 1;
          return { ...seat, status: next };
        });
        if (seats.every((seat, i) => seat === section.seats[i])) return section;
        availableDelta += sectionDelta;
        return { ...section, seats, availableCount: section.availableCount + sectionDelta };
      });
      return availableDelta === 0 && sections.every((s, i) => s === prev.sections[i])
        ? prev
        : { ...prev, sections, availableSeats: prev.availableSeats + availableDelta };
    });

    const taken = [...changes].filter(([, status]) => status !== 'AVAILABLE').map(([id]) => id);
    if (taken.length > 0) {
      setSelectedIds((prev) => {
        const lost = prev.filter((id) => taken.includes(id));
        if (lost.length === 0) return prev;
        setFlashedIds(new Set(lost));
        setTimeout(() => setFlashedIds(new Set()), 2500);
        return prev.filter((id) => !lost.includes(id));
      });
    }
  });

  const refetch = useCallback(async () => {
    const fresh = await getSeatAvailability(eventId);
    setAvailability(fresh);
    return fresh;
  }, [eventId]);

  function toggleSeat(seatId: string): void {
    setSelectedIds((prev) => {
      if (prev.includes(seatId)) return prev.filter((id) => id !== seatId);
      if (prev.length >= maxSeats) return prev;
      return [...prev, seatId];
    });
  }

  function handleFocus(seatId: string): void {
    setFocusedId(seatId);
  }

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const firstAvailableId = allSeats.find((s) => s.status === 'AVAILABLE')?.id ?? allSeats[0]?.id ?? null;
  const activeId = focusedId ?? firstAvailableId;

  function moveFocus(seatId: string | undefined): void {
    if (!seatId) return;
    setFocusedId(seatId);
    buttonRefs.current.get(seatId)?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, sectionIndex: number, seatIndex: number): void {
    const section = availability.sections[sectionIndex];
    if (!section) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveFocus(section.seats[seatIndex + 1]?.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveFocus(section.seats[seatIndex - 1]?.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(availability.sections[sectionIndex + 1]?.seats[seatIndex]?.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(availability.sections[sectionIndex - 1]?.seats[seatIndex]?.id);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const seat = section.seats[seatIndex];
      if (seat?.status === 'AVAILABLE') toggleSeat(seat.id);
    }
  }

  const conflictRecovery = useCallback(async () => {
    const fresh = await refetch();
    const freshById = new Map(fresh.sections.flatMap((s) => s.seats).map((s) => [s.id, s]));
    setSelectedIds((prev) => {
      const nowUnavailable = prev.filter((id) => freshById.get(id)?.status !== 'AVAILABLE');
      if (nowUnavailable.length > 0) {
        setFlashedIds(new Set(nowUnavailable));
        setTimeout(() => setFlashedIds(new Set()), 2500);
      }
      return prev.filter((id) => !nowUnavailable.includes(id));
    });
  }, [refetch]);

  async function handleReserve(): Promise<void> {
    try {
      if (useGrid) {
        await onReserve(selectedIds);
      } else {
        // "Pick best available" -- lowest-priced available seats, any section.
        const picks = allSeats
          .filter((s) => s.status === 'AVAILABLE')
          .sort((a, b) => a.priceMinor - b.priceMinor)
          .slice(0, quantity)
          .map((s) => s.id);
        await onReserve(picks);
      }
    } catch (err) {
      if (isApiError(err) && err.code === 'SEAT_NOT_AVAILABLE') await conflictRecovery();
      throw err;
    }
  }

  const selectedSeats = selectedIds.map((id) => seatById.get(id)).filter((s): s is SeatAvailabilitySeat => !!s);
  const totalMinor = selectedSeats.reduce((sum, s) => sum + s.priceMinor, 0);
  const currency = availability.currency ?? selectedSeats[0]?.currency ?? 'INR';

  useEffect(() => {
    buttonRefs.current.clear();
  }, [availability]);

  if (availability.totalSeats === 0) {
    return <p className="text-sm text-fg-muted">Seating for this event hasn&apos;t been set up yet.</p>;
  }

  return (
    <div className="space-y-6">
      <SeatLegend />

      {useGrid ? (
        <div className="space-y-6" role="grid" aria-label="Seat map">
          {availability.sections.map((section, sectionIndex) => (
            <div key={section.id} className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-fg">{section.name}</h3>
                <p className="text-xs text-fg-subtle">
                  {section.availableCount} / {section.seatCount} available &middot;{' '}
                  {formatMinor(section.minPriceMinor, section.seats[0]?.currency ?? 'INR')}
                  {section.minPriceMinor !== section.maxPriceMinor &&
                    ` - ${formatMinor(section.maxPriceMinor, section.seats[0]?.currency ?? 'INR')}`}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5" role="row">
                {section.seats.map((seat, seatIndex) => (
                  <SeatButton
                    key={seat.id}
                    seat={seat}
                    selected={selectedIds.includes(seat.id)}
                    flash={flashedIds.has(seat.id)}
                    disabled={isReserving}
                    tabIndex={seat.id === activeId ? 0 : -1}
                    onSelect={toggleSeat}
                    onFocus={handleFocus}
                    onKeyDown={(e) => handleKeyDown(e, sectionIndex, seatIndex)}
                    buttonRef={(el) => {
                      if (el) buttonRefs.current.set(seat.id, el);
                      else buttonRefs.current.delete(seat.id);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <label htmlFor="quantity" className="text-sm text-fg-muted">
            Number of seats
          </label>
          <input
            id="quantity"
            type="number"
            min={1}
            max={maxSeats}
            value={quantity}
            onChange={(e) => setQuantity(Math.min(maxSeats, Math.max(1, Number(e.target.value) || 1)))}
            className="h-9 w-20 rounded-md border border-border-strong bg-surface-2 px-2 text-sm text-fg"
          />
          <p className="text-xs text-fg-subtle">We&apos;ll pick the best available seats for you.</p>
        </div>
      )}

      <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-strong bg-surface-2/95 p-4 shadow-glow backdrop-blur">
        <div>
          {useGrid ? (
            <>
              <p className="text-sm font-medium text-fg">
                {selectedSeats.length} seat{selectedSeats.length === 1 ? '' : 's'} selected
              </p>
              <p className="text-xs text-fg-muted">
                {selectedSeats.length > 0 ? formatMinor(totalMinor, currency) : `Up to ${maxSeats} seats`}
              </p>
            </>
          ) : (
            <p className="text-sm font-medium text-fg">{quantity} seat(s) at best available price</p>
          )}
        </div>
        <Button
          onClick={() => void handleReserve()}
          disabled={(useGrid && selectedSeats.length === 0) || isReserving}
          isLoading={isReserving}
        >
          Reserve
        </Button>
      </div>
    </div>
  );
}
