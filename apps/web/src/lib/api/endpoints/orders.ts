import { apiFetch } from '../client';

import type { Order } from '../types';

export async function createOrder(idempotencyKey: string, reservationId: string): Promise<Order> {
  const { data } = await apiFetch<Order>('/orders', {
    method: 'POST',
    body: { reservationId },
    idempotencyKey,
  });
  return data;
}

export async function listOrders(): Promise<Order[]> {
  const { data } = await apiFetch<Order[]>('/orders');
  return data;
}

export async function getOrder(orderId: string): Promise<Order> {
  const { data } = await apiFetch<Order>(`/orders/${orderId}`);
  return data;
}

export async function retryPayment(idempotencyKey: string, orderId: string): Promise<Order> {
  const { data } = await apiFetch<Order>(`/orders/${orderId}/retry-payment`, {
    method: 'POST',
    idempotencyKey,
  });
  return data;
}

/** Cancels a checkout in progress (PENDING) or a paid booking (PAID ->
 * tickets cancelled, refund queued). Idempotent via the key. */
export async function cancelOrder(idempotencyKey: string, orderId: string): Promise<Order> {
  const { data } = await apiFetch<Order>(`/orders/${orderId}/cancel`, {
    method: 'POST',
    idempotencyKey,
  });
  return data;
}
