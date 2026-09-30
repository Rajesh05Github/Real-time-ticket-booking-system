import { Prisma } from '@flashsale/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OrderRepositoryModule from './order.repository.js';
import type { PaymentProvider } from '../../providers/payment-provider.js';
import type * as DatabaseModule from '@flashsale/database';

vi.mock('@flashsale/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return { ...actual, releaseReservation: vi.fn(), recordAuditLog: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../events/event.repository.js', () => ({
  findEventById: vi.fn(),
}));

vi.mock('../reservations/reservation.repository.js', () => ({
  findReservationById: vi.fn(),
}));

vi.mock('./order.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OrderRepositoryModule>();
  return {
    ...actual,
    createOrderWithFirstPayment: vi.fn(),
    setPaymentProviderRef: vi.fn().mockResolvedValue(undefined),
    findOrderById: vi.fn(),
    listOrdersForUser: vi.fn(),
    findPaymentByProviderRefWithContext: vi.fn(),
    applyPaymentSucceeded: vi.fn(),
    applyPaymentFailed: vi.fn(),
    createRetryPayment: vi.fn(),
    cancelPaidOrder: vi.fn(),
  };
});

const { findReservationById } = await import('../reservations/reservation.repository.js');
const orderRepository = await import('./order.repository.js');
const { findEventById } = await import('../events/event.repository.js');
const { releaseReservation } = await import('@flashsale/database');
const { cancelOrder, createOrder, getOrderForUser, handlePaymentWebhook, retryPayment } = await import(
  './order.service.js'
);

function fakePaymentProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    name: 'mock',
    charge: vi.fn().mockResolvedValue({ providerRef: 'provider-ref-1' }),
    ...overrides,
  };
}

function futureDate(): Date {
  return new Date(Date.now() + 10 * 60 * 1000);
}

function pastDate(): Date {
  return new Date(Date.now() - 1000);
}

const RESERVED_RESERVATION = {
  id: 'res-1',
  userId: 'user-1',
  status: 'RESERVED',
  expiresAt: futureDate(),
  items: [
    { status: 'ACTIVE', seat: { priceMinor: 50_000, currency: 'INR' } },
    { status: 'ACTIVE', seat: { priceMinor: 30_000, currency: 'INR' } },
  ],
};

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createOrder', () => {
  it('404s when the reservation does not exist', async () => {
    vi.mocked(findReservationById).mockResolvedValue(null);
    await expect(createOrder(fakePaymentProvider(), 'user-1', 'res-1')).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("403s when the reservation isn't the caller's own", async () => {
    vi.mocked(findReservationById).mockResolvedValue({ ...RESERVED_RESERVATION, userId: 'someone-else' } as never);
    await expect(createOrder(fakePaymentProvider(), 'user-1', 'res-1')).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('rejects a reservation that is not RESERVED', async () => {
    vi.mocked(findReservationById).mockResolvedValue({ ...RESERVED_RESERVATION, status: 'PENDING_PAYMENT' } as never);
    await expect(createOrder(fakePaymentProvider(), 'user-1', 'res-1')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });

  it('rejects a reservation whose hold has already expired', async () => {
    vi.mocked(findReservationById).mockResolvedValue({ ...RESERVED_RESERVATION, expiresAt: pastDate() } as never);
    await expect(createOrder(fakePaymentProvider(), 'user-1', 'res-1')).rejects.toMatchObject({
      code: 'RESERVATION_EXPIRED',
    });
  });

  it('sums seat prices into amountMinor and charges the provider with that exact amount', async () => {
    vi.mocked(findReservationById).mockResolvedValue(RESERVED_RESERVATION as never);
    vi.mocked(orderRepository.createOrderWithFirstPayment).mockResolvedValue({
      ok: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
    });
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      reservationId: 'res-1',
      status: 'PENDING',
      amountMinor: 80_000n,
      currency: 'INR',
      payments: [],
    } as never);
    const provider = fakePaymentProvider();

    const order = await createOrder(provider, 'user-1', 'res-1');

    expect(orderRepository.createOrderWithFirstPayment).toHaveBeenCalledWith('user-1', 'res-1', 80_000n, 'INR', 'mock');
    expect(provider.charge).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', paymentId: 'payment-1', amountMinor: 80_000n, currency: 'INR' }),
    );
    expect(orderRepository.setPaymentProviderRef).toHaveBeenCalledWith('payment-1', 'provider-ref-1');
    // serializeOrder (the REAL implementation, not mocked) converts the
    // bigint to a string -- proves the response actually goes through it.
    expect(order.amountMinor).toBe('80000');
  });

  it('converts a Postgres unique-constraint violation (Order.reservationId) into ORDER_ALREADY_EXISTS', async () => {
    vi.mocked(findReservationById).mockResolvedValue(RESERVED_RESERVATION as never);
    vi.mocked(orderRepository.createOrderWithFirstPayment).mockRejectedValue(uniqueConstraintError());

    await expect(createOrder(fakePaymentProvider(), 'user-1', 'res-1')).rejects.toMatchObject({
      code: 'ORDER_ALREADY_EXISTS',
      httpStatus: 409,
    });
  });

  it('rejects when the reservation lost the race between the pre-check and the atomic update', async () => {
    vi.mocked(findReservationById).mockResolvedValue(RESERVED_RESERVATION as never);
    vi.mocked(orderRepository.createOrderWithFirstPayment).mockResolvedValue({ ok: false });

    await expect(createOrder(fakePaymentProvider(), 'user-1', 'res-1')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });
});

describe('getOrderForUser', () => {
  it('404s when the order does not exist', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue(null);
    await expect(getOrderForUser('order-1', 'user-1', 'USER')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("403s when the order isn't the caller's own and they aren't an admin", async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({
      id: 'order-1',
      userId: 'someone-else',
      amountMinor: 1000n,
      payments: [],
    } as never);
    await expect(getOrderForUser('order-1', 'user-1', 'USER')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('lets an ADMIN view any order regardless of owner', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({
      id: 'order-1',
      userId: 'someone-else',
      amountMinor: 1000n,
      payments: [],
    } as never);
    await expect(getOrderForUser('order-1', 'admin-1', 'ADMIN')).resolves.toMatchObject({ id: 'order-1' });
  });
});

describe('retryPayment', () => {
  const PENDING_ORDER = {
    id: 'order-1',
    userId: 'user-1',
    status: 'PENDING',
    amountMinor: 80_000n,
    currency: 'INR',
    payments: [{ id: 'payment-1', status: 'FAILED', amountMinor: 80_000n }],
  };

  it('404s when the order does not exist', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue(null);
    await expect(retryPayment(fakePaymentProvider(), 'user-1', 'order-1')).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("403s when the order isn't the caller's own", async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...PENDING_ORDER, userId: 'someone-else' } as never);
    await expect(retryPayment(fakePaymentProvider(), 'user-1', 'order-1')).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('rejects retrying an order that is not PENDING', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...PENDING_ORDER, status: 'PAID' } as never);
    await expect(retryPayment(fakePaymentProvider(), 'user-1', 'order-1')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });

  it('rejects retrying while the latest payment is still PENDING (not FAILED)', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({
      ...PENDING_ORDER,
      payments: [{ id: 'payment-1', status: 'PENDING', amountMinor: 80_000n }],
    } as never);
    await expect(retryPayment(fakePaymentProvider(), 'user-1', 'order-1')).rejects.toMatchObject({
      code: 'PAYMENT_RETRY_NOT_ALLOWED',
    });
    expect(orderRepository.createRetryPayment).not.toHaveBeenCalled();
  });

  it('creates a new Payment attempt and charges the provider again after a FAILED attempt', async () => {
    vi.mocked(orderRepository.findOrderById)
      .mockResolvedValueOnce(PENDING_ORDER as never)
      .mockResolvedValueOnce({
        ...PENDING_ORDER,
        payments: [{ id: 'payment-2', status: 'PENDING', amountMinor: 80_000n }],
      } as never);
    vi.mocked(orderRepository.createRetryPayment).mockResolvedValue({ id: 'payment-2' } as never);
    const provider = fakePaymentProvider();

    await retryPayment(provider, 'user-1', 'order-1');

    expect(orderRepository.createRetryPayment).toHaveBeenCalledWith(PENDING_ORDER, 'mock');
    expect(provider.charge).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'payment-2' }));
    expect(orderRepository.setPaymentProviderRef).toHaveBeenCalledWith('payment-2', 'provider-ref-1');
  });
});

describe('handlePaymentWebhook', () => {
  it('404s when no payment matches the providerRef', async () => {
    vi.mocked(orderRepository.findPaymentByProviderRefWithContext).mockResolvedValue(null);
    await expect(handlePaymentWebhook('unknown-ref', 'succeeded')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('no-ops (does not call applyPaymentSucceeded/Failed) on a duplicate delivery for an already-resolved payment', async () => {
    vi.mocked(orderRepository.findPaymentByProviderRefWithContext).mockResolvedValue({
      id: 'payment-1',
      status: 'SUCCEEDED',
    } as never);

    const result = await handlePaymentWebhook('ref-1', 'succeeded');

    expect(result.processed).toBe(false);
    expect(orderRepository.applyPaymentSucceeded).not.toHaveBeenCalled();
    expect(orderRepository.applyPaymentFailed).not.toHaveBeenCalled();
  });

  it('applies the succeeded transition for a fresh PENDING payment', async () => {
    const payment = { id: 'payment-1', status: 'PENDING' };
    vi.mocked(orderRepository.findPaymentByProviderRefWithContext).mockResolvedValue(payment as never);
    vi.mocked(orderRepository.applyPaymentSucceeded).mockResolvedValue({ applied: true });

    const result = await handlePaymentWebhook('ref-1', 'succeeded');

    expect(orderRepository.applyPaymentSucceeded).toHaveBeenCalledWith(payment);
    expect(orderRepository.applyPaymentFailed).not.toHaveBeenCalled();
    expect(result.processed).toBe(true);
  });

  it('applies the failed transition for a fresh PENDING payment', async () => {
    const payment = { id: 'payment-1', status: 'PENDING' };
    vi.mocked(orderRepository.findPaymentByProviderRefWithContext).mockResolvedValue(payment as never);
    vi.mocked(orderRepository.applyPaymentFailed).mockResolvedValue({ applied: true });

    const result = await handlePaymentWebhook('ref-1', 'failed');

    expect(orderRepository.applyPaymentFailed).toHaveBeenCalledWith(payment);
    expect(orderRepository.applyPaymentSucceeded).not.toHaveBeenCalled();
    expect(result.processed).toBe(true);
  });

  it('surfaces a refundReason when a success could not be applied to its order', async () => {
    vi.mocked(orderRepository.findPaymentByProviderRefWithContext).mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
    } as never);
    vi.mocked(orderRepository.applyPaymentSucceeded).mockResolvedValue({
      applied: true,
      refundReason: 'duplicate_payment',
    });

    const result = await handlePaymentWebhook('ref-1', 'succeeded');

    expect(result.refundReason).toBe('duplicate_payment');
  });
});

describe('cancelOrder', () => {
  const baseOrder = {
    id: 'order-1',
    userId: 'user-1',
    reservationId: 'res-1',
    amountMinor: 80_000n,
    currency: 'INR',
    payments: [],
    tickets: [],
  };

  it("403s when the order isn't the caller's own and they aren't an admin", async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({
      ...baseOrder,
      userId: 'someone-else',
      status: 'PENDING',
    } as never);
    await expect(cancelOrder('order-1', 'user-1', 'USER')).rejects.toMatchObject({ httpStatus: 403 });
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it('cancels a checkout in progress by releasing its reservation (which also cancels the order)', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...baseOrder, status: 'PENDING' } as never);
    vi.mocked(releaseReservation).mockResolvedValue({ released: true, seatIds: ['seat-1'], cancelledOrderId: 'order-1' });

    await cancelOrder('order-1', 'user-1', 'USER');

    expect(releaseReservation).toHaveBeenCalledWith('res-1', 'CANCELLED');
    expect(orderRepository.cancelPaidOrder).not.toHaveBeenCalled();
  });

  it('reports a conflict when the checkout was resolved by another process first', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...baseOrder, status: 'PENDING' } as never);
    vi.mocked(releaseReservation).mockResolvedValue({ released: false, seatIds: [] });

    await expect(cancelOrder('order-1', 'user-1', 'USER')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });

  it('cancels and refunds a PAID order before the event starts', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...baseOrder, status: 'PAID' } as never);
    vi.mocked(findReservationById).mockResolvedValue({ id: 'res-1', eventId: 'event-1' } as never);
    vi.mocked(findEventById).mockResolvedValue({ id: 'event-1', startTime: futureDate() } as never);
    vi.mocked(orderRepository.cancelPaidOrder).mockResolvedValue({
      cancelled: true,
      seatIds: ['seat-1'],
      ticketCount: 1,
    });

    await cancelOrder('order-1', 'user-1', 'USER');

    expect(orderRepository.cancelPaidOrder).toHaveBeenCalledWith('order-1', 'res-1');
  });

  it('refuses a customer cancellation once the event has started', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...baseOrder, status: 'PAID' } as never);
    vi.mocked(findReservationById).mockResolvedValue({ id: 'res-1', eventId: 'event-1' } as never);
    vi.mocked(findEventById).mockResolvedValue({ id: 'event-1', startTime: pastDate() } as never);

    await expect(cancelOrder('order-1', 'user-1', 'USER')).rejects.toMatchObject({
      code: 'EVENT_ALREADY_STARTED',
    });
    expect(orderRepository.cancelPaidOrder).not.toHaveBeenCalled();
  });

  it('lets an ADMIN cancel a PAID order even after the event has started', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({
      ...baseOrder,
      userId: 'someone-else',
      status: 'PAID',
    } as never);
    vi.mocked(findReservationById).mockResolvedValue({ id: 'res-1', eventId: 'event-1' } as never);
    vi.mocked(findEventById).mockResolvedValue({ id: 'event-1', startTime: pastDate() } as never);
    vi.mocked(orderRepository.cancelPaidOrder).mockResolvedValue({ cancelled: true, seatIds: [], ticketCount: 0 });

    await expect(cancelOrder('order-1', 'admin-1', 'ADMIN')).resolves.toMatchObject({ id: 'order-1' });
    expect(orderRepository.cancelPaidOrder).toHaveBeenCalledWith('order-1', 'res-1');
  });

  it('rejects cancelling an order that is already CANCELLED or REFUNDED', async () => {
    vi.mocked(orderRepository.findOrderById).mockResolvedValue({ ...baseOrder, status: 'REFUNDED' } as never);
    await expect(cancelOrder('order-1', 'user-1', 'USER')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });
});
