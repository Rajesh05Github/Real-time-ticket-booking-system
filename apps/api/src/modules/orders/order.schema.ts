import { z } from 'zod';

export const createOrderSchema = z.object({
  reservationId: z.string().uuid(),
});
export type CreateOrderBody = z.infer<typeof createOrderSchema>;

export const orderIdParamsSchema = z.object({
  orderId: z.string().uuid(),
});
