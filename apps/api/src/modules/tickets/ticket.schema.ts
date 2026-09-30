import { z } from 'zod';

export const ticketIdParamsSchema = z.object({
  ticketId: z.string().uuid(),
});
