# Azure Managed Redis, not "Azure Cache for Redis": the latter is being
# retired and new cache creation is blocked for existing customers from
# 2026-10-01 (for new customers since 2026-04-01) -- see
# docs/azure-deployment.md.
#
# Settings that are load-bearing for this codebase:
#  - clustering_policy = NoCluster: BullMQ runs multi-key Lua scripts and
#    the rate limiter/streams assume one keyspace. OSS/Enterprise cluster
#    modes would reject cross-slot multi-key commands.
#  - eviction_policy = NoEviction: same reasoning as docker-compose.yml's
#    `--maxmemory-policy noeviction` -- an evicted lock, session or queue
#    job would be silent corruption; rejecting writes is the loud, correct
#    failure mode.
#  - AOF persistence every second: the domain-event stream and BullMQ
#    queues must survive a node restart (docker-compose.yml's
#    `--appendonly yes`).
#  - Encrypted client protocol (TLS on port 10000) -> REDIS_URL uses
#    rediss://, which packages/config accepts and ioredis handles natively.
resource "azurerm_managed_redis" "main" {
  name                      = "redis-${local.name}-${local.suffix}"
  resource_group_name       = azurerm_resource_group.main.name
  location                  = azurerm_resource_group.main.location
  sku_name                  = var.redis_sku
  high_availability_enabled = var.redis_high_availability
  public_network_access     = "Disabled"

  default_database {
    clustering_policy                             = "NoCluster"
    eviction_policy                               = "NoEviction"
    client_protocol                               = "Encrypted"
    access_keys_authentication_enabled            = true
    persistence_append_only_file_backup_frequency = "1s"
  }

  tags = local.tags
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-${local.name}-redis"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "redis"
    private_connection_resource_id = azurerm_managed_redis.main.id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }

  tags = local.tags
}

locals {
  redis_url = "rediss://:${urlencode(azurerm_managed_redis.main.default_database[0].primary_access_key)}@${azurerm_managed_redis.main.hostname}:${azurerm_managed_redis.main.default_database[0].port}"
}
