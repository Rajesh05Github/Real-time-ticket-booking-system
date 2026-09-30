import { prisma, recordAuditLog } from '@flashsale/database';
import { createBullMQConnection, type Redis } from '@flashsale/redis';
import {
  buildSeatRows,
  JOB_NAMES,
  QUEUE_NAMES,
  SEAT_GENERATION_CHUNK_SIZE,
  type GenerateSeatsJobData,
} from '@flashsale/shared';
import { Worker, type Job } from 'bullmq';

import type { Logger } from '@flashsale/logger';

/**
 * Handles seat-generation requests too large for apps/api's synchronous
 * path (SEAT_GENERATION_SYNC_LIMIT, packages/shared) -- see
 * docs/admin-flow.md for the full reasoning. Chunked inserts +
 * `job.updateProgress()` mean an admin generating 50,000 seats for a
 * real stadium gets a live percentage rather than either a request
 * timeout or a single opaque multi-minute wait.
 */
export function startSeatGenerationWorker(
  redisUrl: string,
  logger: Logger,
  concurrency: number,
): Worker<GenerateSeatsJobData> {
  const connection: Redis = createBullMQConnection(redisUrl);

  const worker = new Worker<GenerateSeatsJobData>(
    QUEUE_NAMES.SEAT_GENERATION,
    async (job: Job<GenerateSeatsJobData>) => {
      if (job.name !== JOB_NAMES.GENERATE_SEATS) {
        throw new Error(`seat-generation-worker received unknown job name: ${job.name}`);
      }

      const { eventId, actorId, assignments } = job.data;
      const rows = buildSeatRows(eventId, assignments);

      let created = 0;
      for (let start = 0; start < rows.length; start += SEAT_GENERATION_CHUNK_SIZE) {
        const chunk = rows.slice(start, start + SEAT_GENERATION_CHUNK_SIZE);
        // skipDuplicates makes a RETRY of this job idempotent: BullMQ
        // restarts a failed job's handler from the top, re-processing
        // every chunk including ones a prior attempt already inserted.
        // Without skipDuplicates, re-inserting an already-created chunk
        // would hit the (eventId, sectionId, seatCode) unique constraint
        // and fail the retry immediately on its first chunk, rather than
        // resuming past what already succeeded. This is different from
        // the synchronous path (seat.repository.ts), which deliberately
        // does NOT skip duplicates -- a single, one-shot admin request
        // hitting a real collision should surface loudly, not silently
        // create fewer seats than asked for.
        const result = await prisma.seat.createMany({ data: chunk, skipDuplicates: true });
        created += result.count;
        await job.updateProgress(Math.round(((start + chunk.length) / rows.length) * 100));
      }

      await recordAuditLog({
        actorId,
        action: 'seats.generated',
        entityType: 'event',
        entityId: eventId,
        metadata: { count: created, mode: 'async', jobId: job.id },
      });

      logger.info({ jobId: job.id, eventId, created }, 'seat generation job completed');
      return { created };
    },
    {
      connection,
      concurrency,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'seat generation job failed');
  });

  return worker;
}
