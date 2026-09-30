import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../events/event.service.js', () => ({
  assertEventVisibleToViewer: vi.fn(),
  getEventOrThrow: vi.fn(),
}));

vi.mock('./seat.repository.js', () => ({
  listSeatAvailabilityForEvent: vi.fn(),
  listSeatsForEvent: vi.fn(),
  createSeatsMany: vi.fn(),
  findSeatsByIds: vi.fn(),
}));

const { assertEventVisibleToViewer } = await import('../events/event.service.js');
const { listSeatAvailabilityForEvent } = await import('./seat.repository.js');
const { getSeatAvailability } = await import('./seat.service.js');

const fakeEvent = {
  id: 'event-1',
  venue: { id: 'venue-1', name: 'Delhi Stadium', city: 'Delhi' },
} as never;

function seatRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `seat-${Math.random()}`,
    seatCode: 'A1',
    priceMinor: 1000,
    currency: 'INR',
    status: 'AVAILABLE',
    section: { id: 'section-a', name: 'Section A' },
    ...overrides,
  };
}

describe('getSeatAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertEventVisibleToViewer).mockResolvedValue(fakeEvent);
  });

  it('delegates the visibility gate to assertEventVisibleToViewer -- a 404 there propagates untouched', async () => {
    const notFound = new Error('not found');
    vi.mocked(assertEventVisibleToViewer).mockRejectedValue(notFound);

    await expect(getSeatAvailability('event-1', undefined)).rejects.toBe(notFound);
    expect(listSeatAvailabilityForEvent).not.toHaveBeenCalled();
  });

  it('groups seats by section and computes per-section + event-level counts and price ranges', async () => {
    vi.mocked(listSeatAvailabilityForEvent).mockResolvedValue([
      seatRow({ seatCode: 'A1', priceMinor: 1000, status: 'AVAILABLE' }),
      seatRow({ seatCode: 'A2', priceMinor: 1500, status: 'SOLD' }),
      seatRow({
        seatCode: 'B1',
        priceMinor: 2000,
        status: 'RESERVED',
        section: { id: 'section-b', name: 'Section B' },
      }),
    ] as never);

    const result = await getSeatAvailability('event-1', undefined);

    expect(result.eventId).toBe('event-1');
    expect(result.venue).toEqual({ id: 'venue-1', name: 'Delhi Stadium', city: 'Delhi' });
    expect(result.totalSeats).toBe(3);
    expect(result.availableSeats).toBe(1); // only A1
    expect(result.currency).toBe('INR');

    expect(result.sections).toHaveLength(2);
    const sectionA = result.sections.find((s) => s.id === 'section-a');
    expect(sectionA).toMatchObject({
      name: 'Section A',
      seatCount: 2,
      availableCount: 1,
      minPriceMinor: 1000,
      maxPriceMinor: 1500,
    });
  });

  it('a SOLD seat is present in the response, not filtered out', async () => {
    vi.mocked(listSeatAvailabilityForEvent).mockResolvedValue([
      seatRow({ seatCode: 'A1', status: 'SOLD' }),
    ] as never);

    const result = await getSeatAvailability('event-1', undefined);

    expect(result.sections[0]?.seats).toHaveLength(1);
    expect(result.sections[0]?.seats[0]?.status).toBe('SOLD');
  });

  it('sorts seat codes numerically within a section, not lexicographically (A2 before A10)', async () => {
    vi.mocked(listSeatAvailabilityForEvent).mockResolvedValue([
      seatRow({ seatCode: 'A10' }),
      seatRow({ seatCode: 'A2' }),
      seatRow({ seatCode: 'A1' }),
    ] as never);

    const result = await getSeatAvailability('event-1', undefined);

    expect(result.sections[0]?.seats.map((s) => s.seatCode)).toEqual(['A1', 'A2', 'A10']);
  });

  it('reports currency as null when sections disagree, rather than picking one arbitrarily', async () => {
    vi.mocked(listSeatAvailabilityForEvent).mockResolvedValue([
      seatRow({ currency: 'INR' }),
      seatRow({ currency: 'USD', section: { id: 'section-b', name: 'Section B' } }),
    ] as never);

    const result = await getSeatAvailability('event-1', undefined);

    expect(result.currency).toBeNull();
  });

  it('returns an empty sections array (not an error) for an event with zero seats', async () => {
    vi.mocked(listSeatAvailabilityForEvent).mockResolvedValue([]);

    const result = await getSeatAvailability('event-1', undefined);

    expect(result.sections).toEqual([]);
    expect(result.totalSeats).toBe(0);
    expect(result.availableSeats).toBe(0);
    expect(result.currency).toBeNull();
  });
});
