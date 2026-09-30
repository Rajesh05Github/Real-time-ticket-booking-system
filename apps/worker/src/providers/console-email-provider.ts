import type { EmailProvider, SendEmailInput } from './email-provider.js';
import type { Logger } from '@flashsale/logger';

/**
 * LOCAL DEVELOPMENT SIMPLIFICATION: logs the email instead of sending one.
 *
 * This is genuinely how far Phase 4 goes -- no SES/Postmark/SMTP
 * integration yet, deliberately, since the point of this phase is the
 * auth flow and the provider-abstraction pattern, not picking and wiring
 * a real vendor. Swapping this for a real provider means writing one more
 * class implementing EmailProvider and changing ONE line where the worker
 * constructs its provider (apps/worker/src/index.ts) -- nothing about the
 * queue, the job payload, or the auth service changes.
 *
 * NEVER log the OTP at info level in a real deployment -- section 35
 * explicitly forbids logging OTPs. It's logged here at `debug` only, and
 * only because this provider's entire purpose IS to stand in for an email
 * a human would otherwise read; there is no real inbox to leak from in
 * local development.
 */
export class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly logger: Logger) {}

  send(input: SendEmailInput): Promise<void> {
    this.logger.debug(
      { to: input.to, subject: input.subject, body: input.body },
      '[ConsoleEmailProvider] would send email',
    );
    return Promise.resolve();
  }
}
