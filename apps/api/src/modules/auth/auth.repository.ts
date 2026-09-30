import { prisma, type User } from '@flashsale/database';

export function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

/**
 * Registration upsert with a deliberate asymmetry (Phase 0 correction
 * #10): a VERIFIED email is a hard conflict (someone already owns this
 * account) -- an UNVERIFIED email is treated as "still up for grabs" and
 * gets its password overwritten and a fresh OTP issued. Without this,
 * registering with someone else's email address and never verifying it
 * would permanently squat that address, since Postgres's `email` unique
 * constraint would otherwise block the real owner from ever registering.
 *
 * Returns `{ conflict: true }` for the hard-conflict case so the caller
 * (auth.service.ts) can return the right HTTP status without this
 * repository needing to know about HTTP at all.
 */
export async function createOrReclaimUnverifiedUser(
  email: string,
  passwordHash: string,
): Promise<{ user: User } | { conflict: true }> {
  const existing = await findUserByEmail(email);

  if (existing) {
    if (existing.emailVerifiedAt) {
      return { conflict: true };
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash },
    });
    return { user };
  }

  const user = await prisma.user.create({
    data: { email, passwordHash },
  });
  return { user };
}

export function markEmailVerified(userId: string): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
  });
}
