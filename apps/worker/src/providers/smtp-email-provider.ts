import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailProvider, SendEmailInput } from './email-provider.js';

export interface SmtpEmailProviderOptions {
  host: string;
  port: number;
  /** true = implicit TLS (usually port 465); false = STARTTLS on 587. */
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

/**
 * Real email delivery over SMTP -- works with any relay (SendGrid,
 * Mailgun, Postmark, SES's SMTP interface, or Mailpit/MailHog locally).
 *
 * `send()` throwing is the retry signal: the BullMQ email job fails, and
 * the queue's exponential backoff (EMAIL_JOB_MAX_ATTEMPTS) retries it --
 * the Notification row only flips to SENT after this resolves.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;

  constructor(private readonly options: SmtpEmailProviderOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      // STARTTLS is mandatory when not using implicit TLS -- never send
      // credentials or OTPs over a plaintext connection.
      requireTLS: !options.secure,
      ...(options.user !== undefined
        ? { auth: { user: options.user, pass: options.password ?? '' } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(input: SendEmailInput): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
  }

  close(): void {
    this.transporter.close();
  }
}
