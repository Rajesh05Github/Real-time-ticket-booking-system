// Phase 18: creates USER_COUNT real users with real sessions (both the
// Redis hash and the Postgres audit row -- exactly what
// apps/api/src/modules/auth/session.ts's `createSession` writes, just
// inlined here rather than imported: that function lives inside apps/api,
// not a published workspace package, and duplicating ~10 lines here is
// far simpler than restructuring app-internal code into a package purely
// so a load-test script can import it).
//
// WHY THIS EXISTS instead of having k6 log every VU in through
// POST /api/v1/auth/login: login is rate-limited to 10 attempts/minute
// per IP (Phase 8, docs/rate-limiting.md) -- correctly so, that's exactly
// the brute-force protection it exists for. Provisioning hundreds of load
// -test sessions through that route would either take forever (respecting
// the limit) or require weakening a real security control just to make a
// load test's setup faster. Real load testing tools solve this the same
// way: provision test identities OUT OF BAND, then load-test the actual
// endpoint under test (seat reservation) with already-authenticated
// traffic -- see docs/load-testing.md.
//
// Run via `pnpm --filter @flashsale/load-tests run provision` (loads
// ../../.env for DATABASE_URL/REDIS_URL/COOKIE_SECRET, same as every
// other host-run script in this repo, e.g. packages/database's
// migrate:* scripts).

import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import { prisma } from '@flashsale/database';
import { createRedisClient, redisKeys } from '@flashsale/redis';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@flashsale/shared';
import Fastify from 'fastify';

// Phase 20: the same signed double-submit CSRF token
// apps/api/src/plugins/csrf.ts computes -- HMAC(COOKIE_SECRET,
// sessionId), deterministic, no server-side storage. Duplicated here for
// the same reason `createSession`'s logic is duplicated below: it's
// app-internal, not a published workspace package.
function csrfTokenFor(sessionId) {
  return createHmac('sha256', process.env.COOKIE_SECRET).update(sessionId).digest('hex');
}

const USER_COUNT = Number(process.env.LOAD_TEST_USER_COUNT ?? 200);
const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions.json');

async function main() {
  const redis = createRedisClient(process.env.REDIS_URL);

  // A throwaway Fastify + @fastify/cookie instance purely to SIGN cookies
  // the exact same way the real login route does -- same trick as
  // apps/api's rbac.test.ts / reservation-concurrency.integration.test.ts
  // fixtures, so this script never has to reimplement @fastify/cookie's
  // HMAC signing scheme by hand.
  const signer = Fastify();
  await signer.register(cookie, { secret: process.env.COOKIE_SECRET, hook: 'onRequest' });
  signer.get('/sign/:sessionId', (request, reply) => {
    const { sessionId } = request.params;
    reply
      .setCookie(SESSION_COOKIE_NAME, sessionId, { signed: true, path: '/' })
      .setCookie(CSRF_COOKIE_NAME, csrfTokenFor(sessionId), { path: '/' })
      .send({ ok: true });
  });
  await signer.ready();

  console.log(`Provisioning ${USER_COUNT} load-test users + sessions...`);
  const sessions = [];

  for (let i = 0; i < USER_COUNT; i++) {
    const user = await prisma.user.create({
      data: {
        email: `loadtest-${randomUUID()}@example.com`,
        // Never authenticated through the real login route -- see the
        // file header. This value is never checked by anything a load
        // test exercises.
        passwordHash: 'not-checked-by-load-tests',
        emailVerifiedAt: new Date(),
      },
    });

    const sessionId = randomUUID();
    const now = Date.now();
    await redis
      .multi()
      .hset(redisKeys.session(sessionId), {
        userId: user.id,
        role: 'USER',
        createdAt: String(now),
        lastActivityAt: String(now),
      })
      .expire(redisKeys.session(sessionId), SESSION_TTL_SECONDS)
      .exec();
    await prisma.session.create({
      data: { id: sessionId, userId: user.id, expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000) },
    });

    const signed = await signer.inject({ method: 'GET', url: `/sign/${sessionId}` });
    const setCookie = signed.headers['set-cookie'];
    const rawCookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');
    const csrfToken = csrfTokenFor(sessionId);

    sessions.push({ userId: user.id, cookie: cookieHeader, csrfToken });

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${USER_COUNT}`);
    }
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(sessions, null, 2));
  console.log(`Wrote ${sessions.length} sessions to ${OUTPUT_PATH}`);

  redis.disconnect();
  await signer.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
