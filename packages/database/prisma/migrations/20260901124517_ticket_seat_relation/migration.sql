-- Phase 14: `tickets.seat_id` existed as a bare denormalized column with
-- no formal relation since Phase 3 -- found live when GET /tickets/:id
-- tried `include: { seat: true }` and Prisma rejected it outright
-- (no such relation existed to include). The column's own schema
-- comment already explained WHY seat_id is denormalized ("skip a join
-- through ReservationItem to show which seat it is"), but without an
-- actual FK+relation that denormalization couldn't be used for
-- anything -- a caller still needed a second, manual query. This adds
-- the real relation every other reference on this table already has.
CREATE INDEX "tickets_seat_id_idx" ON "tickets"("seat_id");

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_seat_id_fkey" FOREIGN KEY ("seat_id") REFERENCES "seats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
