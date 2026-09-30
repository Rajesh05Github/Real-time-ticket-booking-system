'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Dialog } from '../../../components/ui/dialog';
import { EmptyState } from '../../../components/ui/empty-state';
import { Field, Input, Select, Textarea } from '../../../components/ui/field';
import { Skeleton } from '../../../components/ui/skeleton';
import { StatusBadge } from '../../../components/ui/status-badge';
import { useToast } from '../../../components/ui/toast';
import { createEvent, listEvents, publishEvent, unpublishEvent } from '../../../lib/api/endpoints/events';
import { listVenues } from '../../../lib/api/endpoints/venues';
import { isApiError } from '../../../lib/api/errors';
import { handleApiError } from '../../../lib/api/handle-error';

import type { Event, Venue } from '../../../lib/api/types';

function EventsLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

function NewEventDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (event: Event) => void;
}): React.JSX.Element {
  const { toast } = useToast();
  const [venues, setVenues] = useState<Venue[] | null>(null);
  const [venueId, setVenueId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setStartTime('');
    setVenueId('');
    listVenues()
      .then(setVenues)
      .catch((err: unknown) => handleApiError(err, { toast }));
  }, [open, toast]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!venueId || !startTime) return;
    setIsSaving(true);
    try {
      const event = await createEvent({
        venueId,
        name,
        startTime: new Date(startTime).toISOString(),
        ...(description ? { description } : {}),
      });
      toast({ kind: 'success', title: 'Event created as draft' });
      onCreated(event);
      onClose();
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New event">
      <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
        <Field label="Venue" htmlFor="event-venue">
          <Select
            id="event-venue"
            required
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
            disabled={venues === null}
          >
            <option value="" disabled>
              {venues === null ? 'Loading…' : 'Select a venue'}
            </option>
            {venues?.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" htmlFor="event-name">
          <Input id="event-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="event-description">
          <Textarea
            id="event-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Start time" htmlFor="event-start">
          <Input
            id="event-start"
            type="datetime-local"
            required
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSaving}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function AdminEventsPage(): React.JSX.Element {
  const { toast } = useToast();
  const router = useRouter();
  const [events, setEvents] = useState<Event[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listEvents({ pageSize: 100 });
      setEvents(result.items);
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTogglePublish(event: Event): Promise<void> {
    setTogglingId(event.id);
    try {
      if (event.status === 'PUBLISHED') {
        await unpublishEvent(event.id);
        toast({ kind: 'info', title: 'Event unpublished' });
      } else {
        await publishEvent(event.id);
        toast({ kind: 'success', title: 'Event published' });
      }
      await load();
    } catch (err) {
      handleApiError(err, { toast });
      if (isApiError(err) && err.code === 'EVENT_HAS_NO_SEATS') {
        router.push(`/admin/events/${event.id}/seats`);
      }
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-fg">Events</h1>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          New event
        </Button>
      </div>

      {events === null ? (
        <EventsLoading />
      ) : events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description="Create an event, generate its seats, then publish it."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              New event
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <Card key={event.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge value={event.status} />
                  <span className="font-medium text-fg">{event.name}</span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  {event.venue.name}
                  {event.venue.city ? `, ${event.venue.city}` : ''} &middot;{' '}
                  {new Date(event.startTime).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link href={`/admin/events/${event.id}/seats`}>
                  <Button variant="secondary" size="sm">
                    Seats
                  </Button>
                </Link>
                <Button
                  variant={event.status === 'PUBLISHED' ? 'danger' : 'primary'}
                  size="sm"
                  isLoading={togglingId === event.id}
                  onClick={() => void handleTogglePublish(event)}
                >
                  {event.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <NewEventDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={() => void load()}
      />
    </div>
  );
}
