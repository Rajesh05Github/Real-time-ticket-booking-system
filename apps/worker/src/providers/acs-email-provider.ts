import { EmailClient } from '@azure/communication-email';

import type { EmailProvider, SendEmailInput } from './email-provider.js';

/**
 * Azure Communication Services Email -- the provider the Azure deployment
 * (infra/azure) provisions: an ACS resource linked to an Azure-managed
 * email domain, whose connection string and DoNotReply@ sender address
 * reach this worker as ACS_EMAIL_CONNECTION_STRING / EMAIL_FROM.
 *
 * ACS sends asynchronously: `beginSend` returns a long-running-operation
 * poller, and `pollUntilDone` resolves once ACS has accepted or rejected
 * the message. Anything other than `Succeeded` throws, which fails the
 * BullMQ job and lets its backoff retry it -- same contract as every
 * other EmailProvider.
 */
export class AcsEmailProvider implements EmailProvider {
  private readonly client: EmailClient;

  constructor(
    connectionString: string,
    private readonly from: string,
  ) {
    this.client = new EmailClient(connectionString);
  }

  async send(input: SendEmailInput): Promise<void> {
    const poller = await this.client.beginSend({
      senderAddress: this.from,
      content: { subject: input.subject, plainText: input.body },
      recipients: { to: [{ address: input.to }] },
    });
    const result = await poller.pollUntilDone();
    if (result.status !== 'Succeeded') {
      throw new Error(`ACS email send ended with status ${result.status}: ${result.error?.message ?? 'no detail'}`);
    }
  }
}
