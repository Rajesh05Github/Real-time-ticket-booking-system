import { prisma } from '@flashsale/database';
import { createBullMQConnection, type Redis } from '@flashsale/redis';
import { JOB_NAMES, QUEUE_NAMES, type SendOtpEmailJobData } from '@flashsale/shared';
import { Worker, type Job } from 'bullmq';

import type { EmailProvider } from '../providers/email-provider.js';
import type { Logger } from '@flashsale/logger';

/**
 * Why BullMQ instead of a hand-rolled Redis List queue (section 11's
 * required comparison): this worker gets automatic retry with backoff on
 * a failed `emailProvider.send()` call, a stalled-job recovery mechanism
 * if the process crashes mid-job, and concurrency control -- all for
 * free. Reimplementing even this ONE queue correctly on raw
 * LPUSH/BRPOPLPUSH would mean re-deriving: how to not lose a job if the
 * worker dies between pop and processing, how to back off retries, and
 * how to cap concurrent in-flight jobs. None of that is specific to
 * "sending email" -- it's generic queue-worker plumbing BullMQ has
 * already gotten right.
 */
export function startEmailWorker(
  redisUrl: string,
  emailProvider: EmailProvider,
  logger: Logger,
  concurrency: number,
): Worker<SendOtpEmailJobData> {
  const connection: Redis = createBullMQConnection(redisUrl);

  const worker = new Worker<SendOtpEmailJobData>(
    QUEUE_NAMES.EMAIL,
    async (job: Job<SendOtpEmailJobData>) => {
      if (job.name !== JOB_NAMES.SEND_OTP_EMAIL) {
        // Unknown job name on a queue this worker owns is a deploy-time
        // mismatch (a newer producer, an older worker), not a transient
        // failure -- fail loudly rather than silently drop it.
        throw new Error(`email-worker received unknown job name: ${job.name}`);
      }

      const { notificationId, email, otp } = job.data;

      await emailProvider.send({
        to: email,
        subject: 'Your FLASHSALE verification code',
        body: `Your verification code is ${otp}. It expires in 5 minutes.`,
      });

      // Flip the durable Notification record (docs/database.md) to SENT
      // only after delivery actually succeeds -- if send() throws above,
      // this line never runs, the job retries, and the record correctly
      // stays PENDING until it either succeeds or exhausts its retries.
      await prisma.notification.update({
        where: { id: notificationId },
        data: { status: 'SENT', sentAt: new Date() },
      });

      logger.info({ jobId: job.id, notificationId }, 'otp email delivered');
    },
    {
      connection,
      concurrency,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempt: job?.attemptsMade, err },
      'email job failed',
    );

    // Only on the FINAL attempt, not every intermediate retry -- a job
    // that's about to be retried isn't failed yet from the Notification
    // row's point of view, it's just between attempts. `attemptsMade`
    // reaching the job's own configured `attempts` (Phase 12's
    // EMAIL_JOB_MAX_ATTEMPTS, packages/shared) is what distinguishes
    // "will retry" from "has exhausted every retry." Without this, a
    // Notification row stayed PENDING forever after silent final
    // failure -- invisible in the database, not just slow.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      prisma.notification
        .update({ where: { id: job.data.notificationId }, data: { status: 'FAILED' } })
        .catch((updateErr: unknown) => {
          logger.error(
            { err: updateErr, notificationId: job.data.notificationId },
            'failed to mark notification FAILED after exhausting retries',
          );
        });
    }
  });

  return worker;
}
