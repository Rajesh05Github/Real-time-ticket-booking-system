/**
 * Hand-written wire DTOs -- NEVER import `@flashsale/database` into
 * apps/web (it drags in Prisma + node builtins that have no business in
 * a browser bundle). All dates are ISO strings: apps/api's cached path
 * returns SerializedEvent (Date -> string explicitly), and Fastify's own
 * JSON serialization produces the identical string on the uncached path
 * -- `string` is correct for both, never `Date`.
 */

export type UserRole = 'USER' | 'ADMIN';

export interface MeUser {
  id: string;
  email: string;
  role: UserRole;
  emailVerifiedAt: string | null;
}

export interface LoginUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface Venue {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Section {
  id: string;
  venueId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED' | 'CANCELLED';

export interface EventVenueSummary {
  id: string;
  name: string;
  city: string | null;
}

export interface Event {
  id: string;
  venueId: string;
  name: string;
  description: string | null;
  status: EventStatus;
  startTime: string;
  endTime: string | null;
  createdAt: string;
  updatedAt: string;
  venue: EventVenueSummary;
}

export type SeatStatus = 'AVAILABLE' | 'RESERVED' | 'SOLD';

/** Raw admin seat row (GET /events/:id/seats, admin only). */
export interface Seat {
  id: string;
  eventId: string;
  sectionId: string;
  seatCode: string;
  priceMinor: number;
  currency: string;
  status: SeatStatus;
  createdAt: string;
  updatedAt: string;
}

/** The public/grouped shape (GET /events/:id/seats/availability). */
export interface SeatAvailabilitySeat {
  id: string;
  seatCode: string;
  priceMinor: number;
  currency: string;
  status: SeatStatus;
}

export interface SeatAvailabilitySection {
  id: string;
  name: string;
  seatCount: number;
  availableCount: number;
  minPriceMinor: number;
  maxPriceMinor: number;
  seats: SeatAvailabilitySeat[];
}

export interface SeatAvailability {
  eventId: string;
  venue: { id: string; name: string; city: string | null };
  totalSeats: number;
  availableSeats: number;
  currency: string | null;
  sections: SeatAvailabilitySection[];
}

export interface SeatGenerationAssignment {
  sectionId: string;
  seatCodePrefix: string;
  startNumber: number;
  seatCount: number;
  priceMinor: number;
  currency: string;
}

export type GenerateSeatsResult =
  | { mode: 'sync'; seats: Seat[] }
  | { mode: 'async'; jobId: string };

/** BullMQ job state -- 'completed'/'failed' are the two this app branches
 * on; a plain `string` covers every other transient state
 * (active/waiting/delayed/...) without needing to enumerate BullMQ's
 * full internal state machine here. */
export type SeatGenerationJobState = string;

export interface SeatGenerationJobStatus {
  jobId: string;
  state: SeatGenerationJobState;
  progress: number | object;
  failedReason: string | null;
}

export type ReservationStatus = 'RESERVED' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
export type ReservationItemStatus = 'ACTIVE' | 'RELEASED';

export interface ReservationItem {
  id: string;
  reservationId: string;
  seatId: string;
  status: ReservationItemStatus;
  createdAt: string;
  updatedAt: string;
  seat: Seat;
}

export interface Reservation {
  id: string;
  userId: string;
  eventId: string;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  items: ReservationItem[];
}

export type OrderStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUND_PENDING' | 'REFUNDED';
export type TicketStatus = 'ISSUED' | 'CANCELLED';

export interface Payment {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string | null;
  status: PaymentStatus;
  /** String, not number -- bigint-as-string over the wire. */
  amountMinor: string;
  currency: string;
  refundProviderRef: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Ticket {
  id: string;
  ticketNumber: string;
  userId: string;
  eventId: string;
  orderId: string;
  reservationItemId: string;
  seatId: string;
  status: TicketStatus;
  issuedAt: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketWithContext extends Ticket {
  event: Event;
  seat: Seat;
}

export interface Order {
  id: string;
  userId: string;
  reservationId: string;
  status: OrderStatus;
  /** String, not number -- bigint-as-string over the wire. */
  amountMinor: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  payments: Payment[];
  tickets: Ticket[];
}

export interface WatchStatus {
  watching: boolean;
}

/**
 * The exact shape beyond the OTP case isn't fully confirmed from
 * packages/redis's feed producers -- every field here is what
 * pushToRecentFeed's OTP case writes. Rendered defensively (an unknown
 * `type` gets generic copy) rather than assuming this is the whole union.
 */
export interface NotificationItem {
  id: string;
  type: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface AnalyticsSummary {
  /** Raw HGETALL values -- string-encoded integers, parse before display. */
  eventCounts: Record<string, string>;
  /** Raw HGETALL values -- string-encoded minor-unit amounts per currency. */
  revenueMinorByCurrency: Record<string, string>;
}
