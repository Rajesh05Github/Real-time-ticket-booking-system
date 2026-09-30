import { prisma } from './client.js';
import { writeOutboxEvent } from './outbox.js';

import type { Payment } from '@prisma/client';

export type RefundablePayment = Pick<
  Payment,
  'id' | 'orderId' | 'provider' | 'providerRef' | 'amountMinor' | 'currency'
> & { order: { userId: string } };

/**
 * apps/worker's refund processor query. Oldest first so a backlog drains
 * in the order refunds were promised. `providerRef` is always set for a
 * REFUND_PENDING payment: only a payment the provider reported as
 * SUCCEEDED (identified BY its providerRef) is ever moved to this status.
 */
export function findRefundPendingPayments(limit: number): Promise<RefundablePayment[]> {
  return prisma.payment.findMany({
    where: { status: 'REFUND_PENDING' },
    select: {
      id: true,
      orderId: true,
      provider: true,
      providerRef: true,
      amountMinor: true,
      currency: true,
      order: { select: { userId: true } },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });
}

/**
 * REFUND_PENDING -> REFUNDED once the provider has accepted the refund.
 * Status-guarded (`updateMany ... WHERE status = 'REFUND_PENDING'`) so a
 * second processor instance finishing the same refund concurrently is a
 * harmless no-op, and the provider call itself is made idempotent by
 * passing the payment id as its idempotency key (refund-provider.ts).
 */
export async function markPaymentRefunded(
  payment: RefundablePayment,
  refundProviderRef: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, status: 'REFUND_PENDING' },
      data: { status: 'REFUNDED', refundProviderRef, refundedAt: new Date() },
    });
    if (updated.count === 0) {
      return false;
    }

    await writeOutboxEvent(tx, {
      aggregateType: 'order',
      aggregateId: payment.orderId,
      eventType: 'payment.refunded',
      payload: {
        orderId: payment.orderId,
        paymentId: payment.id,
        userId: payment.order.userId,
        amountMinor: payment.amountMinor.toString(),
        currency: payment.currency,
      },
    });
    return true;
  });
}
