import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../orders/order.service.js', () => ({
  handlePaymentWebhook: vi.fn(),
}));

const { handlePaymentWebhook } = await import('../orders/order.service.js');
const { registerErrorHandler } = await import('../../plugins/error-handler.js');
const { paymentRoutes } = await import('./payment.routes.js');

describe('POST /webhook', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerErrorHandler(app);
    await app.register(paymentRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a request with no webhook secret header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { providerRef: '11111111-1111-1111-1111-111111111111', outcome: 'succeeded' },
    });
    expect(response.statusCode).toBe(401);
    expect(handlePaymentWebhook).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong webhook secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-payment-webhook-secret': 'totally-wrong-secret' },
      payload: { providerRef: '11111111-1111-1111-1111-111111111111', outcome: 'succeeded' },
    });
    expect(response.statusCode).toBe(401);
    expect(handlePaymentWebhook).not.toHaveBeenCalled();
  });

  it('accepts a request with the correct webhook secret and forwards it to handlePaymentWebhook', async () => {
    vi.mocked(handlePaymentWebhook).mockResolvedValue({ processed: true });

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-payment-webhook-secret': 'test-payment-webhook-secret-value' },
      payload: { providerRef: '11111111-1111-1111-1111-111111111111', outcome: 'succeeded' },
    });

    expect(response.statusCode).toBe(200);
    expect(handlePaymentWebhook).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', 'succeeded');
  });

  it('logs a warning but still returns 200 when a success was queued for refund', async () => {
    vi.mocked(handlePaymentWebhook).mockResolvedValue({ processed: true, refundReason: 'order_not_payable' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-payment-webhook-secret': 'test-payment-webhook-secret-value' },
      payload: { providerRef: '11111111-1111-1111-1111-111111111111', outcome: 'succeeded' },
    });

    expect(response.statusCode).toBe(200);
  });
});
