// Phase 18 k6 load test for POST /api/v1/reservations.
//
// docs/database.md has flagged, since Phase 3, that write throughput on
// reservation_items/seats under load is the one place this schema's ID
// strategy (random UUIDv4 primary keys, not sequential) could become a
// real bottleneck. Phase 17's integration test already proved
// CORRECTNESS under concurrency (exactly one winner for one seat) with a
// handful of requests inside a single test process; this script proves
// (or disproves) BEHAVIOR under real sustained load, at a scale an
// in-process vitest test never approaches, run against the actual
// containerized stack (Nginx + api + worker + real Postgres + real
// Redis) rather than a single in-process Fastify instance.
//
// Two scenarios, run back to back (see options.scenarios' startTime):
//
//   hot_seat_contention -- many VUs (default 50) hammering a TINY pool of
//     seats (default 3) for 20s. After the first few requests, every
//     seat in the pool is gone -- every remaining request for the rest of
//     the scenario is a GUARANTEED loss. What this measures is docs
//     reservation-flow.md's actual design claim: does a request for an
//     already-unavailable seat stay CHEAP (rejected fast by the Redis
//     admission-control lock, or a fast Postgres unique-index rejection)
//     under sustained hammering, or does p95 latency degrade -- which
//     would mean contention is leaking into something more expensive
//     than the design intends. This is exactly a real flash-sale's worst
//     moment: everyone refreshing for the one front-row seat that sold
//     out three seconds after the sale opened.
//
//   general_throughput -- more VUs (default 100) each picking a
//     pseudo-random seat out of a larger pool (default 300) for 30s.
//     Seats never get released back to the pool for the length of this
//     scenario (a claimed seat stays RESERVED for RESERVATION_HOLD_SECONDS,
//     far longer than 30s), so this is deliberately NOT tuned to keep
//     every request succeeding -- it measures latency/throughput across
//     a REALISTIC depletion curve (mostly successes early, an increasing
//     share of 409s as the pool empties), the same overall shape a real
//     flash sale's traffic looks like, as the complement to
//     hot_seat_contention's "pool is already empty" focus.
//
// Prerequisites (see docs/load-testing.md):
//   1. The full stack running: `docker compose up -d --build`
//   2. Provisioned sessions:   `pnpm --filter @flashsale/load-tests run provision`
//   3. Run this file with k6 (not `node` -- k6 is its own JS runtime):
//        docker run --rm --network flashsale_flashsale-net \
//          -v "$(pwd)/tests/load:/scripts" grafana/k6 run /scripts/seat-reservation.js
//      On Windows Git Bash, prefix with `MSYS_NO_PATHCONV=1` -- MSYS's
//      automatic POSIX-to-Windows path conversion otherwise mangles the
//      in-container `/scripts/seat-reservation.js` argument into a real
//      Windows filesystem path, which k6 then can't find.
//
// The network name is `flashsale_flashsale-net`, not `flashsale-net` --
// Docker Compose prefixes every network with the project name
// (docker-compose.yml's `name: flashsale`); confirm with
// `docker network ls` if this ever changes. BASE_URL defaults to the
// container-network hostname (`api:4000`) -- see the docker run command
// above, which attaches the k6 container to that same network so it can
// resolve `api` the same way `worker`/`nginx` do.
// Override with `-e BASE_URL=http://localhost:4000` when running k6
// natively on the host instead of in a container.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://api:4000';
const HOT_SEAT_VUS = Number(__ENV.HOT_SEAT_VUS || 50);
const HOT_SEAT_POOL_SIZE = Number(__ENV.HOT_SEAT_POOL_SIZE || 3);
const GENERAL_VUS = Number(__ENV.GENERAL_VUS || 100);
const GENERAL_SEAT_POOL_SIZE = Number(__ENV.GENERAL_SEAT_POOL_SIZE || 300);

// The sessions provision-sessions.mjs wrote -- see that script's header
// for why VUs use pre-provisioned sessions instead of logging in
// themselves (the login route's own, correct, rate limit).
const sessions = JSON.parse(open('./sessions.json'));

const reservationSuccess = new Counter('reservation_success');
const reservationConflict = new Counter('reservation_conflict');
const reservationUnexpected = new Counter('reservation_unexpected_status');
const nonFatalRate = new Rate('reservation_non_fatal'); // true for any 2xx/4xx; false only for 5xx/network errors

export const options = {
  scenarios: {
    hot_seat_contention: {
      executor: 'constant-vus',
      vus: HOT_SEAT_VUS,
      duration: '20s',
      exec: 'hotSeatAttempt',
      startTime: '0s',
    },
    general_throughput: {
      executor: 'constant-vus',
      vus: GENERAL_VUS,
      duration: '30s',
      exec: 'generalAttempt',
      // Staggered, not concurrent with hot_seat_contention -- keeps each
      // scenario's own latency/error metrics easy to read in the summary
      // rather than blended together.
      startTime: '25s',
    },
  },
  thresholds: {
    // These numbers are a MEASURED local-dev baseline, not aspirational
    // guesses and not a production SLA -- see docs/load-testing.md for
    // the full story. The first version of this script used 500ms/300ms
    // guessed targets and both failed on the very first real run against
    // this project's single-container dev stack: p95 came back at
    // ~920ms (hot) / ~2.28s (general). The root cause is architectural,
    // not a bug: `DATABASE_URL` carries no `connection_limit`, so
    // Prisma's pool defaults to `num_cpus*2+1` -- a single, small pool
    // shared by every one of 150 concurrent VUs through one `api`
    // container. That's real, useful information a load test is
    // SUPPOSED to surface (docs/database.md predicted exactly this
    // class of bottleneck since Phase 3), not something to paper over by
    // picking thresholds that always pass. The values below are set from
    // that actual run with headroom, and are overridable via
    // `-e HOT_SEAT_P95_MS=500 -e GENERAL_P95_MS=300` to re-check against
    // the ORIGINAL aspirational targets once connection pooling
    // (PgBouncer, a tuned `connection_limit`, horizontal api scaling --
    // all deliberately out of scope for this phase) is in place.
    'http_req_duration{scenario:hot_seat_contention}': [`p(95)<${Number(__ENV.HOT_SEAT_P95_MS || 1200)}`],
    'http_req_duration{scenario:general_throughput}': [`p(95)<${Number(__ENV.GENERAL_P95_MS || 2600)}`],
    // Both scenarios: every response should be a real HTTP status this
    // API returns on purpose (2xx/4xx) -- a 5xx or network error is a
    // real failure, not an expected "seat gone" outcome. This one held
    // at 100% on the very first successful run and is the threshold that
    // actually matters most: LATENCY under contention is expected to
    // vary with environment, CORRECTNESS under contention is not
    // supposed to, ever.
    reservation_non_fatal: ['rate>0.99'],
  },
};

function sessionFor(vu) {
  return sessions[(vu - 1) % sessions.length];
}

function attemptReservation(eventId, seatId, tag) {
  const session = sessionFor(__VU);
  const idempotencyKey = `loadtest-${tag}-${__VU}-${__ITER}-${Math.random().toString(36).slice(2)}`;

  const res = http.post(
    `${BASE_URL}/api/v1/reservations`,
    JSON.stringify({ eventId, seatIds: [seatId] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        Cookie: session.cookie,
        // Phase 20's CSRF double-submit header -- provision-sessions.mjs
        // writes the matching token per session, the same value already
        // present in `session.cookie`'s CSRF crumb.
        'X-CSRF-Token': session.csrfToken,
      },
      tags: { name: 'POST /reservations' },
    },
  );

  const isSuccess = res.status === 201;
  const isConflict = res.status === 409 || res.status === 404;

  if (isSuccess) reservationSuccess.add(1);
  else if (isConflict) reservationConflict.add(1);
  else reservationUnexpected.add(1);

  nonFatalRate.add(res.status < 500);

  check(res, {
    'status is 201, 404, or 409 (never a server error)': () => isSuccess || isConflict,
  });
}

export function setup() {
  if (sessions.length === 0) {
    throw new Error('sessions.json is empty -- run: pnpm --filter @flashsale/load-tests run provision');
  }

  const maxVus = Math.max(HOT_SEAT_VUS, GENERAL_VUS);
  if (sessions.length < maxVus) {
    console.warn(
      `Only ${sessions.length} provisioned sessions but up to ${maxVus} concurrent VUs -- sessions will be ` +
        'reused across VUs (fine for load purposes, just means some "different users" share one identity).',
    );
  }

  // ONE real admin login for the whole setup -- the rate limit provision
  // -sessions.mjs works around only applies to the many FAN sessions the
  // scenarios themselves need, not this single one-time setup call.
  const adminEmail = __ENV.ADMIN_EMAIL || 'admin@flashsale.dev';
  const adminPassword = __ENV.ADMIN_PASSWORD || 'Password123!';
  const loginRes = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: adminEmail, password: adminPassword }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (loginRes.status !== 200) {
    throw new Error(`admin login failed (${loginRes.status}): ${loginRes.body}`);
  }
  // `loginRes.cookies`, not a raw `Set-Cookie` header split -- login now
  // sets TWO cookies (session + Phase 20's CSRF double-submit cookie),
  // and k6's `.cookies` object is what correctly separates multiple
  // Set-Cookie headers instead of only ever seeing the first one.
  const sessionCookieValue = loginRes.cookies['flashsale_sid'][0].value;
  const csrfCookieValue = loginRes.cookies['flashsale_csrf'][0].value;
  const adminCookie = `flashsale_sid=${sessionCookieValue}; flashsale_csrf=${csrfCookieValue}`;
  const adminHeaders = {
    'Content-Type': 'application/json',
    Cookie: adminCookie,
    'X-CSRF-Token': csrfCookieValue,
  };

  const venueRes = http.post(
    `${BASE_URL}/api/v1/venues`,
    JSON.stringify({ name: `Phase 18 Load Test Arena ${Date.now()}` }),
    { headers: adminHeaders },
  );
  const venueId = venueRes.json('data.id');

  const sectionRes = http.post(
    `${BASE_URL}/api/v1/venues/${venueId}/sections`,
    JSON.stringify({ name: 'GA' }),
    { headers: adminHeaders },
  );
  const sectionId = sectionRes.json('data.id');

  const eventRes = http.post(
    `${BASE_URL}/api/v1/events`,
    JSON.stringify({
      venueId,
      name: `Phase 18 Load Test Event ${Date.now()}`,
      startTime: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { headers: adminHeaders },
  );
  const eventId = eventRes.json('data.id');

  const totalSeats = HOT_SEAT_POOL_SIZE + GENERAL_SEAT_POOL_SIZE;
  const seatsRes = http.post(
    `${BASE_URL}/api/v1/events/${eventId}/seats`,
    JSON.stringify({
      assignments: [
        { sectionId, seatCodePrefix: 'L', startNumber: 1, seatCount: totalSeats, priceMinor: 100_000, currency: 'INR' },
      ],
    }),
    { headers: adminHeaders },
  );
  if (seatsRes.status !== 201 && seatsRes.status !== 202) {
    throw new Error(`seat creation failed (${seatsRes.status}): ${seatsRes.body}`);
  }

  // totalSeats defaults to 303 (3 hot + 300 general), well above the
  // admin-flow's 200-seat sync/async cutoff (docs/admin-flow.md) -- this
  // will be a 202 + jobId almost every default run, not the 201 path.
  // Polled here rather than assumed synchronous, unlike the two smaller
  // (single-digit-to-tens of seats) creations above that are always sync.
  if (seatsRes.status === 202) {
    const jobId = seatsRes.json('data.jobId');
    const maxAttempts = 30;
    let state = 'unknown';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const jobRes = http.get(`${BASE_URL}/api/v1/events/${eventId}/seats/generation-jobs/${jobId}`, {
        headers: adminHeaders,
      });
      state = jobRes.json('data.state');
      if (state === 'completed') break;
      if (state === 'failed') {
        throw new Error(`seat generation job ${jobId} failed: ${jobRes.json('data.failedReason')}`);
      }
      sleep(0.5);
    }
    if (state !== 'completed') {
      throw new Error(`seat generation job ${jobId} did not complete after ${maxAttempts * 0.5}s (state: ${state})`);
    }
  }

  // No body, no Content-Type -- this route takes neither (see the admin
  // flow's own curl example in README.md). Sending Content-Type:
  // application/json with a null body here previously surfaced a real
  // bug found live by this exact script: Fastify's own
  // FST_ERR_CTP_EMPTY_JSON_BODY error was falling through
  // error-handler.ts's catch-all as a misleading 500 instead of its own
  // 400 -- fixed in error-handler.ts; this call is now also just
  // correct.
  const publishRes = http.post(`${BASE_URL}/api/v1/events/${eventId}/publish`, null, {
    headers: { Cookie: adminCookie, 'X-CSRF-Token': csrfCookieValue },
  });
  if (publishRes.status !== 200) {
    throw new Error(`event publish failed (${publishRes.status}): ${publishRes.body}`);
  }

  const seatsListRes = http.get(`${BASE_URL}/api/v1/events/${eventId}/seats`, { headers: adminHeaders });
  const allSeats = seatsListRes.json('data');
  if (allSeats.length < totalSeats) {
    throw new Error(
      `expected ${totalSeats} seats, got ${allSeats.length} -- bulk seat creation may still be running ` +
        'as a background job (docs/admin-flow.md); re-run setup after it completes, or lower the pool sizes.',
    );
  }

  const hotSeatIds = allSeats.slice(0, HOT_SEAT_POOL_SIZE).map((s) => s.id);
  const generalSeatIds = allSeats.slice(HOT_SEAT_POOL_SIZE, totalSeats).map((s) => s.id);

  console.log(
    `Setup complete: event ${eventId}, ${hotSeatIds.length} hot seats, ${generalSeatIds.length} general seats.`,
  );

  return { eventId, hotSeatIds, generalSeatIds };
}

export function hotSeatAttempt(data) {
  const seatId = data.hotSeatIds[__ITER % data.hotSeatIds.length];
  attemptReservation(data.eventId, seatId, 'hot');
  sleep(0.1);
}

export function generalAttempt(data) {
  const seatId = data.generalSeatIds[Math.floor(Math.random() * data.generalSeatIds.length)];
  attemptReservation(data.eventId, seatId, 'general');
  sleep(0.3);
}
