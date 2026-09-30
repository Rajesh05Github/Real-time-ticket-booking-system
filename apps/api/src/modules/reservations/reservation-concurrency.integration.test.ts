import { randomUUID } from 'node:crypto';

import { prisma } from '@flashsale/database';
import { createRedisClient, redisKeys, type Redis } from '@flashsale/redis';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@flashsale/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { setCsrfCookie } from '../../plugins/csrf.js';
import { createSession } from '../auth/session.js';

import type { FastifyInstance } from 'fastify';

/**
 * The one claim this codebase has repeated across every reservation-flow
 * doc since Phase 9 -- "ten truly concurrent requests for the same seat
 * produce exactly one 201 and nine 409s, enforced by the Postgres
 * partial unique index, not the Redis lock" -- has, until this phase,
 * only ever been checked by hand (curl loops against a live Docker
 * stack). `reservation.service.test.ts` cannot prove it: it mocks Prisma
 * entirely, so there is no real transaction, no real unique index, and
 * no real race to lose. This is exactly the class of test Phase 17's
 * docker-compose.test.yml exists for -- see docs/testing.md.
 *
 * Real Fastify app (`buildApp()`), real Postgres, real Redis -- `pnpm
 * test:integration` (root) brings up docker-compose.test.yml and runs
 * migrations first; see package.json.
 */
describe('POST /api/v1/reservations -- concurrent claims for one seat (real Postgres + Redis)', () => {
  const CONCURRENT_USERS = 10;
  // Unique per test PROCESS, not a fixed literal -- idempotency_keys'
  // `@@unique([route, key])` is real and global across runs against this
  // same database, unlike a mocked unit test's Prisma. A fixed key
  // string worked on the FIRST run and then failed the second (every
  // request replayed the first run's stored IDEMPOTENCY_KEY_REUSED/
  // SEAT_NOT_AVAILABLE outcome instead of racing a fresh seat) -- found
  // live by literally running this test twice in a row, exactly the kind
  // of bug this project's "verify against the real thing" discipline
  // exists to catch. See docs/testing.md.
  const runId = randomUUID();

  let app: FastifyInstance;
  let redis: Redis;
  let venueId: string;
  let eventId: string;
  let seatId: string;
  const userIds: string[] = [];
  const sessionIds: string[] = [];
  const cookies: string[] = [];
  const csrfTokens: string[] = [];

  beforeAll(async () => {
    app = await buildApp();

    // Test-only helper, registered BEFORE app.ready() (Fastify forbids
    // adding routes afterward) -- signs a cookie exactly the way
    // auth.routes.ts's real login route does, without duplicating
    // @fastify/cookie's signing internals here. Same pattern as
    // rbac.test.ts's fixture. Also sets the Phase 20 CSRF cookie via the
    // REAL `setCsrfCookie` helper (not reimplemented here) -- sessions
    // created directly via `createSession` below never go through the
    // real `/login` route, so nothing else would ever issue it.
    app.get('/test-only/sign-cookie/:sessionId', (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, { signed: true, path: '/' });
      setCsrfCookie(reply, sessionId);
      reply.send({ ok: true });
    });

    await app.ready();

    redis = createRedisClient(process.env.REDIS_URL as string);

    const venue = await prisma.venue.create({ data: { name: 'Phase 17 Integration Test Arena' } });
    venueId = venue.id;
    const section = await prisma.section.create({ data: { venueId, name: 'GA' } });
    const event = await prisma.event.create({
      data: {
        venueId,
        name: 'Phase 17 Integration Test Event',
        status: 'PUBLISHED',
        startTime: new Date(Date.now() + 86_400_000),
      },
    });
    eventId = event.id;
    const seat = await prisma.seat.create({
      data: { eventId, sectionId: section.id, seatCode: 'X1', priceMinor: 100_000, currency: 'INR' },
    });
    seatId = seat.id;

    for (let i = 0; i < CONCURRENT_USERS; i++) {
      const user = await prisma.user.create({
        data: {
          email: `phase17-concurrency-${randomUUID()}@example.com`,
          // Never checked in this test -- sessions are created directly
          // (createSession below), bypassing the login route entirely.
          passwordHash: 'not-checked-in-this-test',
        },
      });
      userIds.push(user.id);

      const { sessionId } = await createSession(redis, {
        userId: user.id,
        role: 'USER',
        userAgent: undefined,
        ipAddress: undefined,
      });
      sessionIds.push(sessionId);

      const signed = await app.inject({ method: 'GET', url: `/test-only/sign-cookie/${sessionId}` });
      const setCookie = signed.headers['set-cookie'];
      const rawCookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      if (rawCookies.length < 2 || !rawCookies[0] || !rawCookies[1]) {
        throw new Error('test setup failed: expected two Set-Cookie headers (session + CSRF)');
      }
      // Both cookies, combined into one Cookie header -- a real browser
      // sends every cookie for the origin on one request, not one per
      // Set-Cookie response that originally created it.
      cookies.push(rawCookies.map((c) => (c as string).split(';')[0]).join('; '));
      const csrfSetCookie = rawCookies.find((c) => (c as string).startsWith(`${CSRF_COOKIE_NAME}=`));
      const csrfToken = csrfSetCookie?.split(';')[0]?.split('=')[1];
      if (!csrfToken) throw new Error('test setup failed: no CSRF Set-Cookie header returned');
      csrfTokens.push(csrfToken);
    }
  });

  afterAll(async () => {
    // FK-safe deletion order (Reservation/ReservationItem cascade; Seat/
    // Event/User are onDelete: Restrict -- see schema.prisma). Keeps
    // repeated LOCAL `pnpm test:integration` runs (without a `down -v`
    // in between) from accumulating rows across runs, on top of
    // docker-compose.test.yml's own from-scratch guarantee.
    await prisma.idempotencyKey.deleteMany({ where: { key: { startsWith: `phase17-concurrency-${runId}-` } } });
    await prisma.reservation.deleteMany({ where: { eventId } });
    await prisma.seat.deleteMany({ where: { eventId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.section.deleteMany({ where: { venueId } });
    await prisma.venue.deleteMany({ where: { id: venueId } });
    await Promise.all(sessionIds.map((id) => redis.del(redisKeys.session(id))));
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    redis.disconnect();
    await app.close();
    await prisma.$disconnect();
  });

  it(
    'lets exactly ONE of many truly concurrent requests claim the seat; every other gets 409 SEAT_NOT_AVAILABLE',
    async () => {
      const responses = await Promise.all(
        cookies.map((cookie, i) =>
          app.inject({
            method: 'POST',
            url: '/api/v1/reservations',
            headers: {
              cookie,
              'content-type': 'application/json',
              'idempotency-key': `phase17-concurrency-${runId}-${i}`,
              [CSRF_HEADER_NAME]: csrfTokens[i] as string,
            },
            payload: { eventId, seatIds: [seatId] },
          }),
        ),
      );

      const succeeded = responses.filter((r) => r.statusCode === 201);
      const conflicted = responses.filter((r) => r.statusCode === 409);

      // The actual claim this test exists to prove: not "most" requests
      // lost, not "at least one" won -- EXACTLY one 201, and every other
      // request rejected, out of a real Promise.all race against a real
      // Postgres transaction.
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(CONCURRENT_USERS - 1);
      for (const response of conflicted) {
        expect(response.json()).toMatchObject({
          success: false,
          error: { code: 'SEAT_NOT_AVAILABLE' },
        });
      }

      // And the DATABASE, not just the HTTP responses, agrees: one
      // RESERVED seat, one ACTIVE reservation_item referencing it -- the
      // partial unique index (docs/database.md) is what actually
      // guarantees this, independent of anything the Redis admission
      // lock did or didn't do.
      const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
      expect(seat.status).toBe('RESERVED');

      const activeItems = await prisma.reservationItem.findMany({ where: { seatId, status: 'ACTIVE' } });
      expect(activeItems).toHaveLength(1);
    },
    15_000,
  );
});
