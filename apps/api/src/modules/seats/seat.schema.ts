import { z } from 'zod';

const seatAssignmentSchema = z.object({
  sectionId: z.string().uuid(),
  seatCodePrefix: z.string().trim().min(1).max(10),
  startNumber: z.number().int().positive().default(1),
  // Sanity cap, not the sync/async threshold (SEAT_GENERATION_SYNC_LIMIT
  // governs that) -- this just rejects an obviously-malformed request
  // (e.g. a typo producing a billion) before it ever reaches a queue.
  seatCount: z.number().int().positive().max(100_000),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().trim().length(3).default('INR'),
});

export const generateSeatsSchema = z.object({
  assignments: z.array(seatAssignmentSchema).min(1).max(50),
});
export type GenerateSeatsBody = z.infer<typeof generateSeatsSchema>;

export const eventIdParamsSchema = z.object({
  eventId: z.string().uuid(),
});

export const generationJobParamsSchema = z.object({
  eventId: z.string().uuid(),
  jobId: z.string().min(1),
});
