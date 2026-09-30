import { MAX_SEATS_PER_RESERVATION } from '@flashsale/shared';
import { z } from 'zod';

export const createReservationSchema = z.object({
  eventId: z.string().uuid(),
  seatIds: z.array(z.string().uuid()).min(1).max(MAX_SEATS_PER_RESERVATION),
});
export type CreateReservationBody = z.infer<typeof createReservationSchema>;

export const reservationIdParamsSchema = z.object({
  reservationId: z.string().uuid(),
});
