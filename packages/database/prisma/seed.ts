import { PrismaClient, UserRole } from '@prisma/client';
// bcryptjs ships as CommonJS with no named ESM exports -- default import
// + property access is required, not a style choice.
import bcrypt from 'bcryptjs';

/**
 * Local development seed data. Run via `pnpm --filter @flashsale/database
 * seed` (or automatically after `prisma migrate reset`).
 *
 * This is a standalone script, not importing packages/database's own
 * `prisma` singleton (src/client.ts) -- that singleton is meant for
 * long-lived processes (api/worker) with graceful shutdown wired around
 * it; a one-shot seed script just needs its own client it explicitly
 * disconnects at the end.
 *
 * Idempotent by design: every upsert is keyed on a natural unique field
 * (email, venue+section name, event+section+seatCode) so re-running this
 * script against a database that already has this data is a no-op, not a
 * pile of duplicate rows. That matters because `migrate reset` calls this
 * automatically, and a developer re-running `pnpm seed` by habit shouldn't
 * need to wipe the database first.
 */
const prisma = new PrismaClient();

const ADMIN_EMAIL = 'admin@flashsale.dev';
const USER_EMAIL = 'fan@flashsale.dev';
// LOCAL DEVELOPMENT SIMPLIFICATION: a fixed, published dev-only password.
// Never seed real credentials this way outside a local/CI database.
const SEED_PASSWORD = 'Password123!';

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      passwordHash,
      role: UserRole.ADMIN,
      emailVerifiedAt: new Date(),
    },
  });

  const fan = await prisma.user.upsert({
    where: { email: USER_EMAIL },
    update: {},
    create: {
      email: USER_EMAIL,
      passwordHash,
      role: UserRole.USER,
      emailVerifiedAt: new Date(),
    },
  });

  // Venue + sections are reusable physical layout (schema.prisma's
  // comment on the Section model) -- upserting on (venueId, name) means
  // re-running this script against the same venue never duplicates them.
  let venue = await prisma.venue.findFirst({ where: { name: 'Delhi Stadium' } });
  venue ??= await prisma.venue.create({
    data: { name: 'Delhi Stadium', city: 'Delhi', address: 'Feroz Shah Kotla Ground' },
  });

  const sectionNames = ['A', 'B', 'C', 'D'] as const;
  const sections = await Promise.all(
    sectionNames.map((name) =>
      prisma.section.upsert({
        where: { venueId_name: { venueId: venue.id, name } },
        update: {},
        create: { venueId: venue.id, name },
      }),
    ),
  );

  // The example from section 3 of the project brief: India vs Australia,
  // 10 September 2026, Delhi Stadium.
  let event = await prisma.event.findFirst({
    where: { name: 'India vs Australia', venueId: venue.id },
  });
  event ??= await prisma.event.create({
    data: {
      name: 'India vs Australia',
      description: 'Cricket international at Delhi Stadium.',
      venueId: venue.id,
      status: 'PUBLISHED',
      startTime: new Date('2026-09-10T14:00:00.000Z'),
      endTime: new Date('2026-09-10T22:00:00.000Z'),
    },
  });

  // 10 seats per section (A1..A10, B1..B10, ...), priced by section --
  // enough to exercise multi-seat reservation (MAX_SEATS_PER_RESERVATION
  // = 6, packages/shared) without seeding thousands of rows for a local
  // dev database.
  const sectionPricingMinor: Record<(typeof sectionNames)[number], number> = {
    A: 500000, // premium, INR 5,000.00
    B: 350000,
    C: 200000,
    D: 100000,
  };

  for (const section of sections) {
    const sectionName = section.name as (typeof sectionNames)[number];
    for (let seatNumber = 1; seatNumber <= 10; seatNumber += 1) {
      const seatCode = `${sectionName}${seatNumber}`;
      await prisma.seat.upsert({
        where: {
          eventId_sectionId_seatCode: {
            eventId: event.id,
            sectionId: section.id,
            seatCode,
          },
        },
        update: {},
        create: {
          eventId: event.id,
          sectionId: section.id,
          seatCode,
          priceMinor: sectionPricingMinor[sectionName],
          currency: 'INR',
        },
      });
    }
  }

  const seatCount = await prisma.seat.count({ where: { eventId: event.id } });

  console.log('Seed complete:');
  console.log(`  admin: ${admin.email} / ${SEED_PASSWORD}`);
  console.log(`  user:  ${fan.email} / ${SEED_PASSWORD}`);
  console.log(`  venue: ${venue.name} (${venue.id})`);
  console.log(`  event: ${event.name} (${event.id}) -- ${seatCount} seats across ${sections.length} sections`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
