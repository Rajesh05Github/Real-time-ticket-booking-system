'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Dialog } from '../../../components/ui/dialog';
import { EmptyState } from '../../../components/ui/empty-state';
import { Field, Input } from '../../../components/ui/field';
import { Skeleton } from '../../../components/ui/skeleton';
import { useToast } from '../../../components/ui/toast';
import { createSection, createVenue, listSections, listVenues } from '../../../lib/api/endpoints/venues';
import { handleApiError } from '../../../lib/api/handle-error';

import type { Section, Venue } from '../../../lib/api/types';

function VenuesLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

function NewVenueDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setCity('');
      setAddress('');
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setIsSaving(true);
    try {
      await createVenue({ name, ...(city ? { city } : {}), ...(address ? { address } : {}) });
      toast({ kind: 'success', title: 'Venue created' });
      onCreated();
      onClose();
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New venue">
      <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
        <Field label="Name" htmlFor="venue-name">
          <Input id="venue-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="City" htmlFor="venue-city">
          <Input id="venue-city" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Address" htmlFor="venue-address">
          <Input id="venue-address" value={address} onChange={(e) => setAddress(e.target.value)} />
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

function SectionsPanel({ venueId }: { venueId: string }): React.JSX.Element {
  const { toast } = useToast();
  const [sections, setSections] = useState<Section[] | null>(null);
  const [newName, setNewName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setSections(await listSections(venueId));
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [venueId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!newName.trim()) return;
    setIsSaving(true);
    try {
      await createSection(venueId, newName.trim());
      setNewName('');
      await load();
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Sections</p>
      {sections === null ? (
        <Skeleton className="h-6 w-full" />
      ) : sections.length === 0 ? (
        <p className="text-sm text-fg-subtle">No sections yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {sections.map((section) => (
            <li
              key={section.id}
              className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-fg-muted"
            >
              {section.name}
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={(e) => void handleAdd(e)}>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Section name"
          className="h-8 max-w-48 text-xs"
        />
        <Button type="submit" size="sm" variant="secondary" isLoading={isSaving}>
          Add
        </Button>
      </form>
    </div>
  );
}

export default function AdminVenuesPage(): React.JSX.Element {
  const { toast } = useToast();
  const [venues, setVenues] = useState<Venue[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setVenues(await listVenues());
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-fg">Venues</h1>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          New venue
        </Button>
      </div>

      {venues === null ? (
        <VenuesLoading />
      ) : venues.length === 0 ? (
        <EmptyState
          title="No venues yet"
          description="Create a venue before adding events."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              New venue
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {venues.map((venue) => (
            <Card key={venue.id} className="p-4">
              <p className="font-medium text-fg">{venue.name}</p>
              <p className="text-sm text-fg-muted">
                {[venue.address, venue.city].filter(Boolean).join(', ') || 'No address on file'}
              </p>
              <SectionsPanel venueId={venue.id} />
            </Card>
          ))}
        </div>
      )}

      <NewVenueDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={() => void load()} />
    </div>
  );
}
