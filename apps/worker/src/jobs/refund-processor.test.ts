import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MockRefundProvider, RefundProviderRegistry } from '../providers/refund-provider.js';

import type { Logger } from '@flashsale/logger';

vi.mock('@flashsale/database', () => ({
  findRefundPendingPayments: vi.fn(),
  markPaymentRefunded: vi.fn(),
}));

const { findRefundPendingPayments, markPaymentRefunded } = await import('@flashsale/database');
const { startRefundProcessor } = await import('./refund-processor.js');

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function payment(id: string, provider = 'mock', providerRef: string | null = `ref-${id}`) {
  return { id, orderId: `order-${id}`, provider, providerRef, amountMinor: 1000n, currency: 'INR', order: { userId: 'u1' } };
}

describe('startRefundProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refunds each REFUND_PENDING payment through its own provider and records it', async () => {
    vi.mocked(findRefundPendingPayments).mockResolvedValue([payment('p1')] as never);
    vi.mocked(markPaymentRefunded).mockResolvedValue(true);
    const provider = new MockRefundProvider();
    const refundSpy = vi.spyOn(provider, 'refund');

    const processor = startRefundProcessor(new RefundProviderRegistry({ mock: provider }), silentLogger);
    await vi.waitFor(() => expect(markPaymentRefunded).toHaveBeenCalled(), { timeout: 2000 });
    await processor.stop();

    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'p1', providerRef: 'ref-p1', amountMinor: 1000n, currency: 'INR' }),
    );
    expect(markPaymentRefunded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.stringMatching(/^mock_refund_/),
    );
  });

  it('keeps going after one refund fails, leaving the failed one REFUND_PENDING for the next tick', async () => {
    vi.mocked(findRefundPendingPayments).mockResolvedValue([payment('p1', 'unknown-gateway'), payment('p2')] as never);
    vi.mocked(markPaymentRefunded).mockResolvedValue(true);

    const processor = startRefundProcessor(new RefundProviderRegistry({ mock: new MockRefundProvider() }), silentLogger);
    await vi.waitFor(() => expect(markPaymentRefunded).toHaveBeenCalled(), { timeout: 2000 });
    await processor.stop();

    expect(markPaymentRefunded).toHaveBeenCalledTimes(1);
    expect(markPaymentRefunded).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }), expect.any(String));
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'p1' }),
      'refund attempt failed -- will retry',
    );
  });

  it('is idempotent per payment: the mock provider returns the same refund ref on retry', async () => {
    const provider = new MockRefundProvider();
    const input = { paymentId: 'p1', providerRef: 'ref', amountMinor: 1n, currency: 'INR' };
    const first = await provider.refund(input);
    const second = await provider.refund(input);
    expect(second.refundProviderRef).toBe(first.refundProviderRef);
  });
});
