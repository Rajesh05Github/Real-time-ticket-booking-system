export { prisma } from './client.js';
export { recordAuditLog } from './audit.js';
export { findExpiredReservationIds, lockReservation, releaseReservation } from './reservations.js';
export type { LockedReservationRow, ReleaseReservationResult } from './reservations.js';
export { findRefundPendingPayments, markPaymentRefunded } from './refunds.js';
export type { RefundablePayment } from './refunds.js';
export { deleteExpiredIdempotencyKeys } from './idempotency-keys.js';
export type { IdempotencyKeyCleanupResult } from './idempotency-keys.js';
export {
  findPendingOutboxEvents,
  markOutboxEventPublished,
  recordOutboxPublishFailure,
  writeOutboxEvent,
} from './outbox.js';
export type { OutboxEventInput } from './outbox.js';
export { tryMarkEventProcessed } from './processed-events.js';

// Re-export every generated model/enum type so consumers import types from
// @flashsale/database instead of reaching into @prisma/client directly --
// keeps the Prisma dependency itself an implementation detail of this
// package rather than something every app has to declare and version
// itself.
export * from '@prisma/client';
