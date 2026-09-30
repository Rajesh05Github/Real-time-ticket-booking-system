import { OTP_LENGTH } from '@flashsale/shared';
import { z } from 'zod';

// Section 33: every external input is validated. These schemas are the
// single source of truth for what a valid request body looks like --
// route handlers never hand-check fields themselves.

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Minimum length only, deliberately -- composition rules (uppercase +
  // digit + symbol requirements) are a well-documented anti-pattern that
  // push users toward predictable substitutions ("Password1!") without
  // measurably improving guessability. Length is the strongest single
  // lever available here.
  password: z.string().min(8).max(72), // bcrypt silently truncates beyond 72 bytes
});
export type RegisterBody = z.infer<typeof registerSchema>;

export const verifyOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  otp: z.string().length(OTP_LENGTH).regex(/^\d+$/, 'OTP must be numeric'),
});
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;

export const resendOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
export type ResendOtpBody = z.infer<typeof resendOtpSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginSchema>;
