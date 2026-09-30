// Deletes everything a load-test run leaves behind: every load-test user
// (and its session, cascaded -- schema.prisma's Session.user onDelete:
// Cascade), every reservation those users made, and every venue/event/
// section/seat seat-reservation.js's setup() created. All identified by
// name/email PATTERN alone (`loadtest-*@example.com`, `Phase 18 Load
// Test*`), not by reading back a specific run's sessions.json -- run
// this any time to fully clear ALL load-test data regardless of how many
// provisioning + k6 runs happened since the last cleanup.
//
// Run via `pnpm --filter @flashsale/load-tests run cleanup`.

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '@flashsale/database';

const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions.json');

async function main() {
  const loadTestUserFilter = { email: { startsWith: 'loadtest-', endsWith: '@example.com' } };

  // Reservation.userId is onDelete: Restrict (an audit-trail guarantee,
  // not an oversight -- schema.prisma), so a load-test run that actually
  // reserved seats leaves rows here that block deleting the User
  // directly. Found live on the FIRST real cleanup run, right after
  // seat-reservation.js's own real reservations existed for the first
  // time -- ReservationItem cascades off Reservation, so deleting these
  // first (before Session/User below) is enough; no separate
  // ReservationItem cleanup needed.
  const { count: reservationCount } = await prisma.reservation.deleteMany({
    where: { user: loadTestUserFilter },
  });
  console.log(`Deleted ${reservationCount} load-test reservations.`);

  const { count } = await prisma.user.deleteMany({ where: loadTestUserFilter });
  console.log(`Deleted ${count} load-test users (sessions cascaded).`);

  // FK-safe order for seat-reservation.js's own setup() data: Seat is
  // onDelete: Restrict against both Event and Section (schema.prisma),
  // so it must go first. Every ReservationItem that referenced these
  // seats is already gone via the Reservation cleanup above (Reservation
  // -> ReservationItem cascades), so no separate step is needed for
  // those.
  const loadTestEventFilter = { name: { startsWith: 'Phase 18 Load Test Event' } };
  const loadTestVenueFilter = { name: { startsWith: 'Phase 18 Load Test Arena' } };
  const { count: seatCount } = await prisma.seat.deleteMany({ where: { event: loadTestEventFilter } });
  const { count: eventCount } = await prisma.event.deleteMany({ where: loadTestEventFilter });
  const { count: sectionCount } = await prisma.section.deleteMany({ where: { venue: loadTestVenueFilter } });
  const { count: venueCount } = await prisma.venue.deleteMany({ where: loadTestVenueFilter });
  console.log(
    `Deleted ${seatCount} seats, ${eventCount} events, ${sectionCount} sections, ${venueCount} venues.`,
  );

  await rm(OUTPUT_PATH, { force: true });
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
