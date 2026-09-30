/**
 * Provider abstraction (section 23's pattern, applied here to email
 * instead of payments): business logic in the email worker calls this
 * interface, never a specific vendor's SDK directly. Swapping in a real
 * provider (SES, Postmark, Resend, ...) later means implementing this
 * interface once, not touching every call site that currently sends mail.
 */
export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  send(input: SendEmailInput): Promise<void>;
}
