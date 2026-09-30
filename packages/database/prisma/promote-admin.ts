import { PrismaClient, UserRole } from '@prisma/client';

/**
 * Promotes an EXISTING account to ADMIN -- the production way to get a
 * first admin, since seed.ts's fixed demo credentials must never be run
 * against a real database.
 *
 *   1. Register the account normally through the web app and verify its
 *      email (so its owner has actually proven control of the inbox).
 *   2. Run this against the target database:
 *        tsx prisma/promote-admin.ts someone@example.com
 *      (on Azure: `az containerapp job start` on the migrate job with a
 *      command override -- see docs/azure-deployment.md).
 *
 * Refuses unverified accounts, and is idempotent.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    throw new Error('usage: tsx prisma/promote-admin.ts <email>');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`no user registered with email ${email} -- register through the app first`);
  }
  if (!user.emailVerifiedAt) {
    throw new Error(`${email} has not verified its email yet -- verify it before promoting`);
  }
  if (user.role === UserRole.ADMIN) {
    console.log(`${email} is already an ADMIN`);
    return;
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { role: UserRole.ADMIN } }),
    prisma.auditLog.create({
      data: { actorId: null, action: 'user.promoted_to_admin', entityType: 'user', entityId: user.id },
    }),
  ]);
  console.log(`${email} promoted to ADMIN (existing sessions pick up the new role on next login)`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
