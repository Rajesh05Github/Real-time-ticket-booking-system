resource "random_password" "postgres_admin" {
  length = 40
  # Alphanumeric only: the password is embedded in DATABASE_URL, and URL
  # metacharacters in it would need percent-encoding in every consumer.
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                = "psql-${local.name}-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = var.postgres_version
  sku_name            = var.postgres_sku

  storage_mb            = var.postgres_storage_mb
  auto_grow_enabled     = true
  backup_retention_days = var.postgres_backup_retention_days

  administrator_login    = "flashsale"
  administrator_password = random_password.postgres_admin.result

  # Private access only: VNet-integrated, no public endpoint at all.
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false

  dynamic "high_availability" {
    for_each = var.postgres_zone_redundant_ha ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  tags = local.tags

  lifecycle {
    # Azure picks the zone on creation; don't fight it on later plans.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "flashsale"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  postgres_base_url = "postgresql://flashsale:${random_password.postgres_admin.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.app.name}?sslmode=require"

  # Per-process Prisma pool sizes (docs/production-hardening.md): the
  # api's pool is per REPLICA, so api_max_replicas x 10 + worker_replicas
  # x 10 must stay well under the SKU's max_connections.
  database_url_api     = "${local.postgres_base_url}&connection_limit=10"
  database_url_worker  = "${local.postgres_base_url}&connection_limit=10"
  database_url_migrate = local.postgres_base_url
}
