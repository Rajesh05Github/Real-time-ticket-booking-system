import { prisma } from './client.js';

import type { Prisma } from '@prisma/client';

/**
 * Records one admin/system action (schema.prisma's AuditLog model,
 * created in Phase 3, first used in Phase 5). Lives here rather than in
 * apps/api specifically because BOTH apps/api (admin routes) and
 * apps/worker (the seat-generation background job, which also needs to
 * record what it did on completion) need to write audit entries, and
 * apps/worker cannot import apps/api's code -- this is a persistence
 * concern that belongs next to the Prisma client itself, not duplicated
 * in each app that touches it.
 *
 * `actorId` is nullable at the schema level for system-initiated actions
 * (e.g. a future expiry sweeper cancelling a reservation with no human
 * actor) but required here: every current call site has a real actor,
 * since every route that calls this sits behind admin authorization, and
 * the worker job carries the admin's id through from the request that
 * enqueued it.
 */
export function recordAuditLog(input: {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<{ id: string }> {
  return prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
    select: { id: true },
  });
}
