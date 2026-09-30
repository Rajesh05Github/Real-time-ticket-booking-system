import { Prisma } from '@flashsale/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DatabaseModule from '@flashsale/database';
import type { Redis } from '@flashsale/redis';

vi.mock('@flashsale/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    recordAuditLog: vi.fn().mockResolvedValue(undefined),
    releaseReservation: vi.fn(),
  };
});

vi.mock('../events/event.repository.js', () => ({
  findEventById: vi.fn(),
}));

vi.mock('../seats/seat.repository.js', () => ({
  findSeatsByIds: vi.fn(),
}));

vi.mock('./reservation.repository.js', () => ({
  createReservationWithItems: vi.fn(),
  findReservationById: vi.fn(),
  listReservationsForUser: vi.fn(),
}));

vi.mock('../../queues/reservation-expiry-queue.js', () => ({
  reservationExpiryQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

const { recordAuditLog, releaseReservation } = await import('@flashsale/database');
const { findEventById } = await import('../events/event.repository.js');
const { findSeatsByIds } = await import('../seats/seat.repository.js');
const { reservationExpiryQueue } = await import('../../queues/reservation-expiry-queue.js');
const reservationRepository = await import('./reservation.repository.js');
const {
  cancelReservation,
  createReservation,
  getReservationForUser,
} = await import('./reservation.service.js');

const PUBLISHED_EVENT = { id: 'evt-1', status: 'PUBLISHED' };

function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findEventById).mockResolvedValue(PUBLISHED_EVENT as never);
  // Echoes back exactly the seats asked for -- individual tests override
  // this (e.g. to simulate a nonexistent seat) by mocking a shorter array.
  vi.mocked(findSeatsByIds).mockImplementation(
    (eventId, seatIds) => Promise.resolve(seatIds.map((id) => ({ id, eventId }))) as never,
  );
});

describe('createReservation', () => {
  it('rejects a request that lists the same seat twice, before touching Redis or the database', async () => {
    const redis = fakeRedis();

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a', 'seat-a'])).rejects.toMatchObject({
      code: 'DUPLICATE_SEAT_IDS',
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('404s when the event does not exist or is not PUBLISHED (same visibility rule as browsing)', async () => {
    vi.mocked(findEventById).mockResolvedValue(null);
    const redis = fakeRedis();

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a'])).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('404s when a requested seat does not exist for this event', async () => {
    // Only 1 of the 2 requested seats comes back -- simulates seat-b not
    // existing (or not belonging to this event).
    vi.mocked(findSeatsByIds).mockResolvedValue([{ id: 'seat-a', eventId: 'evt-1' }] as never);
    const redis = fakeRedis();

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a', 'seat-b'])).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('acquires a sorted-order Redis lock per seat and releases all of them after a successful claim', async () => {
    const redis = fakeRedis();
    vi.mocked(reservationRepository.createReservationWithItems).mockResolvedValue({
      id: 'res-1',
      userId: 'user-1',
      eventId: 'evt-1',
      items: [],
    } as never);

    await createReservation(redis, 'user-1', 'evt-1', ['seat-b', 'seat-a']);

    // Sorted, not request order (seat-a before seat-b) -- see
    // reservation.service.ts's acquireSeatLocks comment on why acquisition
    // order is made deterministic.
    expect(vi.mocked(redis.set).mock.calls.map((call) => call[0])).toEqual([
      'lock:seat:seat-a',
      'lock:seat:seat-b',
    ]);
    expect(redis.del).toHaveBeenCalledWith('lock:seat:seat-a');
    expect(redis.del).toHaveBeenCalledWith('lock:seat:seat-b');
  });

  it('fails fast with SEAT_NOT_AVAILABLE (no database call) when a seat lock is already held', async () => {
    const redis = fakeRedis({
      set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null), // second seat's lock already held
    });

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a', 'seat-b'])).rejects.toMatchObject({
      code: 'SEAT_NOT_AVAILABLE',
    });
    expect(reservationRepository.createReservationWithItems).not.toHaveBeenCalled();
    // Releases the ONE lock it did acquire (seat-a) -- not the one it
    // never got (seat-b).
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('lock:seat:seat-a');
  });

  it('fails OPEN on a Redis lock error: proceeds to the database rather than blocking the claim', async () => {
    const redis = fakeRedis({ set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    vi.mocked(reservationRepository.createReservationWithItems).mockResolvedValue({
      id: 'res-1',
      items: [],
    } as never);

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a'])).resolves.toMatchObject({
      id: 'res-1',
    });
  });

  it('converts a Postgres unique-constraint violation (the ACTUAL correctness boundary) into SEAT_NOT_AVAILABLE', async () => {
    const redis = fakeRedis();
    vi.mocked(reservationRepository.createReservationWithItems).mockRejectedValue(uniqueConstraintError());

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a'])).rejects.toMatchObject({
      code: 'SEAT_NOT_AVAILABLE',
      httpStatus: 409,
    });
    // Locks are still released even though the claim failed -- proven via
    // the `finally` block, not a happy-path-only release.
    expect(redis.del).toHaveBeenCalledWith('lock:seat:seat-a');
  });

  it('lets an unrelated database error propagate unchanged (not silently reinterpreted as SEAT_NOT_AVAILABLE)', async () => {
    const redis = fakeRedis();
    const dbOutage = new Error('ECONNREFUSED: could not connect to Postgres');
    vi.mocked(reservationRepository.createReservationWithItems).mockRejectedValue(dbOutage);

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a'])).rejects.toBe(dbOutage);
  });

  it('records an audit log entry on a successful claim', async () => {
    const redis = fakeRedis();
    vi.mocked(reservationRepository.createReservationWithItems).mockResolvedValue({
      id: 'res-1',
      items: [],
    } as never);

    await createReservation(redis, 'user-1', 'evt-1', ['seat-a']);

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reservation.created', actorId: 'user-1' }),
    );
  });

  it('enqueues a delayed expire-reservation job (Phase 12) racing the sweeper for near-instant expiry', async () => {
    const redis = fakeRedis();
    vi.mocked(reservationRepository.createReservationWithItems).mockResolvedValue({
      id: 'res-1',
      items: [],
    } as never);

    await createReservation(redis, 'user-1', 'evt-1', ['seat-a']);

    // .mock.calls[0] + toMatchObject, not a nested expect.any(Number) --
    // see idempotency.test.ts's comment on why: reservationExpiryQueue.add
    // is typed via the REAL bullmq Queue.add signature even though it's
    // mocked at runtime, so a vitest asymmetric matcher (typed `any`)
    // nested inside a strongly-typed object literal argument trips
    // @typescript-eslint/no-unsafe-assignment.
    const [jobName, jobData, jobOptions] = vi.mocked(reservationExpiryQueue.add).mock.calls[0] ?? [];
    expect(jobName).toBe('expire-reservation');
    expect(jobData).toEqual({ reservationId: 'res-1' });
    expect(typeof jobOptions?.delay).toBe('number');
  });

  it('fails open when enqueuing the delayed expiry job errors -- the claim still succeeds', async () => {
    const redis = fakeRedis();
    vi.mocked(reservationRepository.createReservationWithItems).mockResolvedValue({
      id: 'res-1',
      items: [],
    } as never);
    vi.mocked(reservationExpiryQueue.add).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(createReservation(redis, 'user-1', 'evt-1', ['seat-a'])).resolves.toMatchObject({
      id: 'res-1',
    });
  });
});

describe('getReservationForUser', () => {
  it('404s when the reservation does not exist', async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue(null);
    await expect(getReservationForUser('res-1', 'user-1', 'USER')).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("403s when the reservation belongs to a DIFFERENT user and the caller isn't an admin", async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue({
      id: 'res-1',
      userId: 'someone-else',
    } as never);
    await expect(getReservationForUser('res-1', 'user-1', 'USER')).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('lets an ADMIN view any reservation regardless of owner', async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue({
      id: 'res-1',
      userId: 'someone-else',
    } as never);
    await expect(getReservationForUser('res-1', 'admin-1', 'ADMIN')).resolves.toMatchObject({
      id: 'res-1',
    });
  });
});

describe('cancelReservation', () => {
  it('404s when the reservation does not exist', async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue(null);
    await expect(cancelReservation('res-1', 'user-1')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("403s when the reservation isn't the caller's own", async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue({
      id: 'res-1',
      userId: 'someone-else',
      status: 'RESERVED',
    } as never);
    await expect(cancelReservation('res-1', 'user-1')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('rejects cancelling a reservation that is no longer RESERVED', async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue({
      id: 'res-1',
      userId: 'user-1',
      status: 'CONFIRMED',
    } as never);
    await expect(cancelReservation('res-1', 'user-1')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it('calls releaseReservation with CANCELLED and records an audit log on success', async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue({
      id: 'res-1',
      userId: 'user-1',
      status: 'RESERVED',
    } as never);
    vi.mocked(releaseReservation).mockResolvedValue({ released: true, seatIds: ['seat-a'] });

    await cancelReservation('res-1', 'user-1');

    expect(releaseReservation).toHaveBeenCalledWith('res-1', 'CANCELLED');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reservation.cancelled' }),
    );
  });

  it('surfaces a conflict if releaseReservation loses a race (already resolved elsewhere)', async () => {
    vi.mocked(reservationRepository.findReservationById).mockResolvedValue({
      id: 'res-1',
      userId: 'user-1',
      status: 'RESERVED',
    } as never);
    vi.mocked(releaseReservation).mockResolvedValue({ released: false, seatIds: [] });

    await expect(cancelReservation('res-1', 'user-1')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });
});
