import { z } from 'zod';

export const createVenueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500).optional(),
  city: z.string().trim().min(1).max(200).optional(),
});
export type CreateVenueBody = z.infer<typeof createVenueSchema>;

export const createSectionSchema = z.object({
  name: z.string().trim().min(1).max(50),
});
export type CreateSectionBody = z.infer<typeof createSectionSchema>;

export const venueIdParamsSchema = z.object({
  venueId: z.string().uuid(),
});
