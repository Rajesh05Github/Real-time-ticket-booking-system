import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { redisKeys } from '@flashsale/redis';
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
} from '@flashsale/shared';

import type { Redis } from '@flashsale/redis';

/**
 * OTP hashing uses SHA-256, NOT bcrypt.
 *
 * bcrypt's defining property is deliberate slowness -- that's exactly
 * right for a password, where the attacker's cost per guess should be
 * high because there's no other rate limit on guessing. An OTP is
 * different: it already has TWO independent defenses against brute force
 * (a hard cap of OTP_MAX_ATTEMPTS guesses, and a five-minute TTL after
 * which the code is worthless regardless), so the hash's own
 * computational cost isn't the thing standing between an attacker and a
 * correct guess. Using bcrypt here would only add latency to every
 * verify-otp request for no additional security -- a keyed comparison
 * that resists timing attacks (timingSafeEqual, not `===`) is the
 * property that actually matters.
 */
function hashOtp(otp: string): Buffer {
  return createHash('sha256').update(otp).digest();
}

function generateOtp(): string {
  const max = 10 ** OTP_LENGTH;
  return randomInt(0, max).toString().padStart(OTP_LENGTH, '0');
}

export interface IssuedOtp {
  otp: string;
}

/**
 * Generates and stores a fresh OTP, enforcing the resend cooldown.
 * Returns null if the cooldown is still active (caller maps this to a
 * RATE_LIMIT-style response, not a silent no-op).
 */
export async function issueOtp(redis: Redis, userId: string): Promise<IssuedOtp | null> {
  const cooldownKey = redisKeys.otpResendCooldown(userId);
  // SET ... NX is the atomic check-and-set: without it, two concurrent
  // resend requests could both observe "no cooldown yet" and both issue a
  // code, defeating the cooldown's purpose entirely.
  const acquired = await redis.set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS, 'NX');
  if (acquired !== 'OK') {
    return null;
  }

  const otp = generateOtp();
  const key = redisKeys.otp(userId);
  // A fresh send/resend REPLACES any in-flight code and resets the
  // attempt counter -- resending is "start over," not "add another valid
  // code," which would otherwise let an attacker accumulate multiple
  // simultaneously-valid guesses to try.
  await redis
    .multi()
    .hset(key, { hash: hashOtp(otp).toString('hex'), attempts: '0' })
    .expire(key, OTP_TTL_SECONDS)
    .exec();

  return { otp };
}

export type OtpVerifyResult =
  | { outcome: 'valid' }
  | { outcome: 'invalid'; attemptsRemaining: number }
  | { outcome: 'expired_or_not_found' }
  | { outcome: 'locked_out' };

/**
 * Verifies a candidate OTP, consuming it (deleting the Redis key) on
 * success OR on exhausting the attempt budget -- a locked-out code is
 * just as dead as a correctly-used one, so it can't be retried again
 * even if its TTL happens not to have elapsed yet.
 */
export async function verifyOtp(
  redis: Redis,
  userId: string,
  candidate: string,
): Promise<OtpVerifyResult> {
  const key = redisKeys.otp(userId);
  const record = await redis.hgetall(key);

  if (!record.hash) {
    return { outcome: 'expired_or_not_found' };
  }

  const attempts = Number(record.attempts ?? '0');
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(key);
    return { outcome: 'locked_out' };
  }

  const candidateHash = hashOtp(candidate);
  const storedHash = Buffer.from(record.hash, 'hex');
  // Buffers must be equal length before timingSafeEqual is called at all
  // -- it throws on a length mismatch rather than safely returning false,
  // and a malformed/short candidate is exactly the kind of input this
  // function must never let escape as an unhandled exception.
  const isMatch =
    candidateHash.length === storedHash.length && timingSafeEqual(candidateHash, storedHash);

  if (isMatch) {
    await redis.del(key);
    return { outcome: 'valid' };
  }

  const attemptsAfter = await redis.hincrby(key, 'attempts', 1);
  if (attemptsAfter >= OTP_MAX_ATTEMPTS) {
    await redis.del(key);
    return { outcome: 'locked_out' };
  }

  return { outcome: 'invalid', attemptsRemaining: OTP_MAX_ATTEMPTS - attemptsAfter };
}
