import { z } from 'zod';

export const paymentWebhookSchema = z.object({
  providerRef: z.string().uuid(),
  outcome: z.enum(['succeeded', 'failed']),
});
