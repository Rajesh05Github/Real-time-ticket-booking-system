# A single-node cache cluster, not a Redis replication group with
# failover -- mirrors docker-compose.yml's own single Redis container
# exactly (no HA there either). This is a real, honest limitation carried
# straight from local dev, not hidden by AWS's more production-shaped
# primitives: Phase 19's failure testing already proved this codebase
# handles a Redis outage correctly (fail-fast via Phase 20's
# commandTimeout, not a crash) -- accepting that a single AWS node can
# still go down, the same way the local one can, is consistent with that
# finding rather than working around it here.
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "main" {
  cluster_id      = "${local.name_prefix}-redis"
  engine          = "redis"
  engine_version  = "7.1"
  node_type       = var.redis_node_type
  num_cache_nodes = 1
  port            = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  tags = local.common_tags
}
