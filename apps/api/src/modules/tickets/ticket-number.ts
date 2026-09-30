import { randomBytes } from 'node:crypto';

/**
 * 32 characters, no ambiguous-looking ones -- excludes I/L/O/Q
 * specifically because a ticket number is read aloud to support, typed
 * from a printout, or squinted at on a phone screen; 0 vs O and 1 vs I/L
 * are the classic confusions worth designing out at the alphabet level
 * rather than leaving to the reader. Deliberately a power of 2 (not,
 * say, 30 or 33): `byte & 31` maps every one of a random byte's 256
 * values onto these 32 symbols with exactly uniform probability, no
 * modulo bias to reason about.
 */
const TICKET_NUMBER_ALPHABET = '0123456789ABCDEFGHJKMNPRSTUVWXYZ';
const TICKET_NUMBER_LENGTH = 12;

/**
 * 12 symbols from a 32-symbol alphabet is 32^12 (~1.15 x 10^18) possible
 * codes -- the same order of magnitude of collision-freeness this
 * codebase already trusts without incident every time it calls
 * Postgres's `gen_random_uuid()` for a primary key. No retry-on-collision
 * loop here for the same reason none exists for a UUID: at this entropy,
 * treating a collision as impossible is the standard, correct call, not
 * a corner cut. Formatted in dashed groups of 4 purely for human
 * readability (a QR code or the raw string is what software actually
 * matches against -- schema.prisma's own comment on this field).
 */
export function generateTicketNumber(): string {
  const bytes = randomBytes(TICKET_NUMBER_LENGTH);
  let code = '';
  for (let i = 0; i < TICKET_NUMBER_LENGTH; i += 1) {
    code += TICKET_NUMBER_ALPHABET[(bytes[i] as number) & 31];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}
