# Phase 20's docker-compose.yml hardening (docs/production-hardening.md)
# removed every committed fallback secret and required them from `.env`
# instead. This is that same principle one level up: NOTHING here is a
# literal value Terraform state or a `.tfvars` file would need to carry
# in plaintext -- `random_password` generates each secret at `apply`
# time, and only Secrets Manager ever holds the real value. ECS task
# definitions (ecs.tf) reference these by ARN by ARN, never by value, so
# the actual secret never appears in a task definition, a CloudWatch log,
# or `terraform plan/apply` output.

resource "random_password" "postgres" {
  length  = 32
  special = false # RDS master passwords reject several special characters; alphanumeric is simplest here
}

resource "random_password" "cookie_secret" {
  length  = 64
  special = false
}

resource "random_password" "payment_webhook_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "database_url" {
  name        = "${local.name_prefix}/database-url"
  description = "Full Postgres connection string for apps/api and apps/worker, including Phase 20's connection_limit tuning."

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  # api's own connection_limit=20 / worker's =10 (docker-compose.yml,
  # Phase 20) carried straight over -- the finding that motivated them
  # (Phase 18's load test) is about Postgres connection contention, which
  # doesn't go away just because the pool now lives on RDS instead of a
  # local container.
  secret_string = "postgresql://${aws_db_instance.postgres.username}:${random_password.postgres.result}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}?connection_limit=20"
}

resource "aws_secretsmanager_secret" "database_url_worker" {
  name        = "${local.name_prefix}/database-url-worker"
  description = "Same database, worker's own smaller connection_limit -- see docker-compose.yml's own comment on why these two values differ."

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "database_url_worker" {
  secret_id     = aws_secretsmanager_secret.database_url_worker.id
  secret_string = "postgresql://${aws_db_instance.postgres.username}:${random_password.postgres.result}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}?connection_limit=10"
}

resource "aws_secretsmanager_secret" "redis_url" {
  name        = "${local.name_prefix}/redis-url"
  description = "Redis connection string for apps/api and apps/worker."

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:${aws_elasticache_cluster.main.cache_nodes[0].port}"
}

resource "aws_secretsmanager_secret" "cookie_secret" {
  name        = "${local.name_prefix}/cookie-secret"
  description = "Signs both the session cookie AND, since Phase 20, derives the CSRF double-submit token (apps/api/src/plugins/csrf.ts) -- one secret, two purposes, deliberately (see that file's own comment on why introducing a second secret wasn't worth it)."

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "cookie_secret" {
  secret_id     = aws_secretsmanager_secret.cookie_secret.id
  secret_string = random_password.cookie_secret.result
}

resource "aws_secretsmanager_secret" "payment_webhook_secret" {
  name        = "${local.name_prefix}/payment-webhook-secret"
  description = "Shared secret the mock payment provider's webhook call must present (docs/payment-flow.md)."

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "payment_webhook_secret" {
  secret_id     = aws_secretsmanager_secret.payment_webhook_secret.id
  secret_string = random_password.payment_webhook_secret.result
}
