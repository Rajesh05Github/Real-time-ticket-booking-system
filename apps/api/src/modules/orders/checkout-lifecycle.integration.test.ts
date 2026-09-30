import { randomUUID } from 'node:crypto';

import { markPaymentRefunded, prisma, releaseReservation } from '@flashsale/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReservationWithItems } from '../reservations/reservation.repository.js';

import {
  applyPaymentSucceeded,
  cancelPaidOrder,
  createOrderWithFirstPayment,
  findPaymentByProviderRefWithContext,
  setPaymentProviderRef,
} from './order.repository.js';

/**
 * The checkout-lifecycle gaps closed after Phase 22 -- checkout timeout,
 * cancelling mid-checkout, late/duplicate payments turning into refunds,
 * and cancelling a paid booking -- all hinge on real row locks
 * (`SELECT ... FOR UPDATE`) and real partial unique indexes, which the
 * mocked unit tests cannot exercise. Same real-Postgres setup as
 * reservation-concurrency.integration.test.ts.
 */
describe('checkout lifecycle (real Postgres)', () => {
  let venueId: string;
  let sectionId: string;
  let eventId: string;
  let userId: string;
  let seatCounter = 0;

  beforeAll(async () => {
    const venue = await prisma.venue.create({ data: { name: `Checkout Lifecycle Arena ${randomUUID()}` } });
    venueId = venue.id;
    const section = await prisma.section.create({ data: { venueId, name: 'GA' } });
    sectionId = section.id;
    const event = await prisma.event.create({
      data: { venueId, name: 'Checkout Lifecycle Event', status: 'PUBLISHED', startTime: new Date(Date.now() + 86_400_000) },
    });
    eventId = event.id;
    const user = await prisma.user.create({
      data: { email: `checkout-lifecycle-${randomUUID()}@example.com`, passwordHash: 'unused' },
    });
    userId = user.id;
  });

  afterAll(async () => {
    const orders = await prisma.order.findMany({ where: { userId }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.reservation.deleteMany({ where: { eventId } });
    await prisma.seat.deleteMany({ where: { eventId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.section.deleteMany({ where: { venueId } });
    await prisma.venue.deleteMany({ where: { id: venueId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /** A fresh seat + RESERVED hold + PENDING order with a providerRef'd payment. */
  async function startCheckout(): Promise<{ seatId: string; reservationId: string; orderId: string; providerRef: string }> {
    seatCounter += 1;
    const seat = await prisma.seat.create({
      data: { eventId, sectionId, seatCode: `L${seatCounter}`, priceMinor: 50_000, currency: 'INR' },
    });
    const reservation = await createReservationWithItems(userId, eventId, [seat.id], new Date(Date.now() + 600_000));
    const created = await createOrderWithFirstPayment(userId, reservation.id, 50_000n, 'INR', 'mock');
    if (!created.ok) throw new Error('test setup: checkout did not start');
    const providerRef = randomUUID();
    await setPaymentProviderRef(created.paymentId, providerRef);
    return { seatId: seat.id, reservationId: reservation.id, orderId: created.orderId, providerRef };
  }

  async function succeed(providerRef: string): Promise<Awaited<ReturnType<typeof applyPaymentSucceeded>>> {
    const payment = await findPaymentByProviderRefWithContext(providerRef);
    if (!payment) throw new Error('payment not found');
    return applyPaymentSucceeded(payment);
  }

  it('extends the hold to the checkout timeout when checkout starts', async () => {
    const { reservationId } = await startCheckout();
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.status).toBe('PENDING_PAYMENT');
    // CHECKOUT_TIMEOUT_SECONDS (900s) from now, i.e. beyond the original 600s hold.
    expect(reservation.expiresAt.getTime()).toBeGreaterThan(Date.now() + 800_000);
  });

  it('does NOT expire a checkout whose extended deadline has not passed (the original delayed job firing early)', async () => {
    const { reservationId } = await startCheckout();
    const result = await releaseReservation(reservationId, 'EXPIRED');
    expect(result.released).toBe(false);
  });

  it('expires an abandoned checkout, then refunds a payment success that arrives late', async () => {
    const { seatId, reservationId, orderId, providerRef } = await startCheckout();
    await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const released = await releaseReservation(reservationId, 'EXPIRED');
    expect(released).toMatchObject({ released: true, seatIds: [seatId], cancelledOrderId: orderId });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe('AVAILABLE');

    const late = await succeed(providerRef);
    expect(late).toEqual({ applied: true, refundReason: 'order_not_payable' });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { providerRef } });
    expect(payment.status).toBe('REFUND_PENDING');
    // The seat stays on sale and no ticket was issued for the late payment.
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe('AVAILABLE');
    expect(await prisma.ticket.count({ where: { orderId } })).toBe(0);
  });

  it('lets the user cancel mid-checkout', async () => {
    const { seatId, reservationId, orderId } = await startCheckout();
    const result = await releaseReservation(reservationId, 'CANCELLED');
    expect(result.released).toBe(true);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status).toBe('CANCELLED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe('AVAILABLE');
  });

  it('racing expiry against payment success always ends in ONE consistent outcome', async () => {
    for (let i = 0; i < 5; i++) {
      const { seatId, reservationId, orderId, providerRef } = await startCheckout();
      await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      await Promise.all([releaseReservation(reservationId, 'EXPIRED'), succeed(providerRef)]);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { providerRef } });
      const tickets = await prisma.ticket.count({ where: { orderId, status: 'ISSUED' } });

      if (order.status === 'PAID') {
        expect([seat.status, payment.status, tickets]).toEqual(['SOLD', 'SUCCEEDED', 1]);
      } else {
        expect(order.status).toBe('CANCELLED');
        expect([seat.status, payment.status, tickets]).toEqual(['AVAILABLE', 'REFUND_PENDING', 0]);
      }
    }
  });

  it('cancels a paid booking: tickets cancelled, seat back on sale, refund recorded end to end', async () => {
    const { seatId, reservationId, orderId, providerRef } = await startCheckout();
    await succeed(providerRef);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe('SOLD');

    const result = await cancelPaidOrder(orderId, reservationId);
    expect(result).toEqual({ cancelled: true, seatIds: [seatId], ticketCount: 1 });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('REFUNDED');
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe('AVAILABLE');
    expect(await prisma.ticket.count({ where: { orderId, status: 'CANCELLED' } })).toBe(1);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerRef },
      include: { order: { select: { userId: true } } },
    });
    expect(payment.status).toBe('REFUND_PENDING');
    expect(await markPaymentRefunded(payment, `refund-${randomUUID()}`)).toBe(true);
    expect((await prisma.payment.findUniqueOrThrow({ where: { providerRef } })).status).toBe('REFUNDED');

    // A second cancel is a clean no-op, not a double refund.
    expect((await cancelPaidOrder(orderId, reservationId)).cancelled).toBe(false);
  });

  it('a seat freed by a cancelled booking can be reserved and ticketed again (partial unique indexes)', async () => {
    const { seatId, reservationId, orderId, providerRef } = await startCheckout();
    await succeed(providerRef);
    await cancelPaidOrder(orderId, reservationId);

    const again = await createReservationWithItems(userId, eventId, [seatId], new Date(Date.now() + 600_000));
    const created = await createOrderWithFirstPayment(userId, again.id, 50_000n, 'INR', 'mock');
    if (!created.ok) throw new Error('second checkout did not start');
    const secondRef = randomUUID();
    await setPaymentProviderRef(created.paymentId, secondRef);
    expect(await succeed(secondRef)).toEqual({ applied: true });
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe('SOLD');
  });
});
