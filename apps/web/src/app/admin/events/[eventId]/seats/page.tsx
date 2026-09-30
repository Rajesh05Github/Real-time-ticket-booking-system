'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminSeatGrid } from '../../../../../components/seat-map/admin-seat-grid';
import { Button } from '../../../../../components/ui/button';
import { Card } from '../../../../../components/ui/card';
import { Field, Input, Select } from '../../../../../components/ui/field';
import { Skeleton } from '../../../../../components/ui/skeleton';
import { useToast } from '../../../../../components/ui/toast';
import { getEvent } from '../../../../../lib/api/endpoints/events';
import { listSeatsAdmin } from '../../../../../lib/api/endpoints/seats';
import { listSections } from '../../../../../lib/api/endpoints/venues';
import { handleApiError } from '../../../../../lib/api/handle-error';
import { useSeatGenerationJob } from '../../../../../lib/hooks/use-seat-generation-job';

import type { Event, Seat, SeatGenerationAssignment, Section } from '../../../../../lib/api/types';

interface AssignmentRow {
  key: number;
  sectionId: string;
  seatCodePrefix: string;
  startNumber: string;
  seatCount: string;
  priceMinor: string;
  currency: string;
}

let rowKeySeq = 0;
function newRow(sectionId: string): AssignmentRow {
  return {
    key: rowKeySeq++,
    sectionId,
    seatCodePrefix: '',
    startNumber: '1',
    seatCount: '10',
    priceMinor: '50000',
    currency: 'INR',
  };
}

export default function AdminEventSeatsPage(): React.JSX.Element {
  const { eventId } = useParams<{ eventId: string }>();
  const { toast } = useToast();

  const [event, setEvent] = useState<Event | null>(null);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [rows, setRows] = useState<AssignmentRow[]>([]);

  const { state: jobState, progress, error: jobError, submit } = useSeatGenerationJob();
  const isSubmitting = jobState === 'submitting' || jobState === 'polling';

  const loadSeats = useCallback(async () => {
    try {
      setSeats(await listSeatsAdmin(eventId));
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [eventId, toast]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const ev = await getEvent(eventId);
        if (cancelled) return;
        setEvent(ev);
        const [secs] = await Promise.all([listSections(ev.venueId), loadSeats()]);
        if (cancelled) return;
        setSections(secs);
        setRows((prev) => (prev.length > 0 ? prev : secs[0] ? [newRow(secs[0].id)] : []));
      } catch (err) {
        if (!cancelled) handleApiError(err, { toast });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    if (jobState === 'sync-done' || jobState === 'async-done') {
      toast({ kind: 'success', title: 'Seats generated' });
      void loadSeats();
    } else if (jobState === 'failed') {
      toast({
        kind: 'error',
        title: 'Seat generation failed',
        ...(jobError ? { description: jobError } : {}),
      });
    }
  }, [jobState, jobError, toast, loadSeats]);

  const sectionNameById = useMemo(
    () => new Map((sections ?? []).map((s) => [s.id, s.name])),
    [sections],
  );

  function updateRow(key: number, patch: Partial<AssignmentRow>): void {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow(): void {
    setRows((prev) => [...prev, newRow(sections?.[0]?.id ?? '')]);
  }

  function removeRow(key: number): void {
    setRows((prev) => prev.filter((row) => row.key !== key));
  }

  async function handleGenerate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const assignments: SeatGenerationAssignment[] = rows.map((row) => ({
      sectionId: row.sectionId,
      seatCodePrefix: row.seatCodePrefix,
      startNumber: Number(row.startNumber) || 1,
      seatCount: Number(row.seatCount) || 0,
      priceMinor: Number(row.priceMinor) || 0,
      currency: row.currency,
    }));
    try {
      await submit(eventId, assignments);
    } catch (err) {
      handleApiError(err, { toast });
    }
  }

  if (!event || sections === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-fg">{event.name} &middot; Seats</h1>
        <p className="text-sm text-fg-muted">
          {event.venue.name}
          {event.venue.city ? `, ${event.venue.city}` : ''}
        </p>
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-fg-muted">
          This venue has no sections yet. Add one from the Venues page before generating seats.
        </p>
      ) : (
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-fg">Generate seats</h2>
          <form className="space-y-3" onSubmit={(e) => void handleGenerate(e)}>
            {rows.map((row) => (
              <div key={row.key} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3 sm:grid-cols-6">
                <Field label="Section" htmlFor={`section-${row.key}`}>
                  <Select
                    id={`section-${row.key}`}
                    value={row.sectionId}
                    onChange={(e) => updateRow(row.key, { sectionId: e.target.value })}
                  >
                    {sections.map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Prefix" htmlFor={`prefix-${row.key}`}>
                  <Input
                    id={`prefix-${row.key}`}
                    value={row.seatCodePrefix}
                    onChange={(e) => updateRow(row.key, { seatCodePrefix: e.target.value })}
                    placeholder="A"
                  />
                </Field>
                <Field label="Start #" htmlFor={`start-${row.key}`}>
                  <Input
                    id={`start-${row.key}`}
                    type="number"
                    min={1}
                    value={row.startNumber}
                    onChange={(e) => updateRow(row.key, { startNumber: e.target.value })}
                  />
                </Field>
                <Field label="Count" htmlFor={`count-${row.key}`}>
                  <Input
                    id={`count-${row.key}`}
                    type="number"
                    min={1}
                    value={row.seatCount}
                    onChange={(e) => updateRow(row.key, { seatCount: e.target.value })}
                  />
                </Field>
                <Field label="Price (minor)" htmlFor={`price-${row.key}`}>
                  <Input
                    id={`price-${row.key}`}
                    type="number"
                    min={0}
                    value={row.priceMinor}
                    onChange={(e) => updateRow(row.key, { priceMinor: e.target.value })}
                  />
                </Field>
                <div className="flex items-end justify-between gap-2">
                  <Field label="Currency" htmlFor={`currency-${row.key}`}>
                    <Input
                      id={`currency-${row.key}`}
                      value={row.currency}
                      onChange={(e) => updateRow(row.key, { currency: e.target.value })}
                    />
                  </Field>
                  {rows.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(row.key)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <div className="flex items-center justify-between">
              <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                Add assignment
              </Button>
              <Button type="submit" isLoading={isSubmitting}>
                Generate
              </Button>
            </div>

            {jobState === 'polling' && (
              <p className="tnum text-xs text-fg-subtle">
                Generating seats in the background…{' '}
                {typeof progress === 'number' ? `${progress}%` : ''}
              </p>
            )}
          </form>
        </Card>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Current seats</h2>
        {seats === null ? (
          <Skeleton className="h-32 w-full rounded-xl" />
        ) : (
          <AdminSeatGrid seats={seats} sectionNameById={sectionNameById} />
        )}
      </div>
    </div>
  );
}
