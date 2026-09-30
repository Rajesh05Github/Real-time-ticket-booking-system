-- Pre-existing drift, unrelated to Phase 14's own changes: schema.prisma
-- has declared `@@index([reservationItemId])` on Ticket since Phase 3,
-- but the migration that should have created it was apparently never
-- generated. Surfaced by `prisma migrate diff` while preparing Phase
-- 13's payment migration and deliberately deferred to this phase
-- instead of bundled in there, since Phase 14 is the phase that actually
-- reads/writes this table. Applied on its own, ahead of any Phase
-- 14-specific schema change, so the two are easy to tell apart in
-- history.
CREATE INDEX "tickets_reservation_item_id_idx" ON "tickets"("reservation_item_id");
