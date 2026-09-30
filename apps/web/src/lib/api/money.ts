/**
 * `Seat.priceMinor` arrives as a plain `number`; `Order`/`Payment.amountMinor`
 * arrive as STRINGS (bigint-as-string over JSON -- see apps/api's
 * SerializedOrder). Accepting both here means callers never have to
 * remember which one they're holding.
 *
 * Divides via BigInt, not `Number(minor) / 100` -- avoids float rounding
 * entirely, which matters once a page starts summing many seats'
 * prices. Assumes 2 decimal places (true for INR, this project's only
 * currency in practice) -- a zero-decimal currency would need
 * `Intl.NumberFormat` to drive the divisor instead; noted, not built,
 * since nothing in this codebase uses one.
 */
export function formatMinor(minor: number | string, currency: string): string {
  const value = typeof minor === 'string' ? BigInt(minor) : BigInt(Math.round(minor));
  const whole = value / 100n;
  const fraction = (value % 100n + 100n) % 100n; // guards a hypothetical negative value
  const amount = `${whole}.${fraction.toString().padStart(2, '0')}`;

  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    // An unrecognized currency code would throw from Intl -- fall back to
    // a plain "CODE amount" rather than crash the page over display
    // formatting.
    return `${currency} ${amount}`;
  }
}
