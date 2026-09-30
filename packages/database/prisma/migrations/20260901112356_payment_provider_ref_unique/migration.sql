-- Phase 13: a webhook delivery identifies which charge attempt it's
-- about purely by providerRef -- two Payment rows ever sharing one would
-- mean one payment's webhook could resolve a completely different
-- payment. Safe despite starting NULL (set only after charge() returns):
-- Postgres unique constraints treat every NULL as distinct from every
-- other NULL, so many PENDING payments can sit with provider_ref = NULL
-- simultaneously without conflict.
CREATE UNIQUE INDEX "payments_provider_ref_key" ON "payments"("provider_ref");
