-- Refund intent status (see schema.prisma's PaymentStatus comment).
-- ADD VALUE is allowed inside Prisma's migration transaction on
-- Postgres 12+ as long as nothing in the SAME transaction uses the new
-- value, which nothing here does.
ALTER TYPE "payment_status" ADD VALUE 'REFUND_PENDING' BEFORE 'REFUNDED';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "refund_provider_ref" TEXT,
ADD COLUMN "refunded_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "payments_refund_provider_ref_key" ON "payments"("refund_provider_ref");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "idempotency_keys_status_created_at_idx" ON "idempotency_keys"("status", "created_at");
