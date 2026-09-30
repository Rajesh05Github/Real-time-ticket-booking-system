data "azurerm_client_config" "current" {}

# Globally-unique names (ACR, Key Vault, Postgres, Redis, ACS) need a
# suffix; generated once and kept in state.
resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  name   = "${var.project_name}-${var.environment}"
  suffix = random_string.suffix.result

  tags = merge(
    {
      project     = var.project_name
      environment = var.environment
      managed-by  = "terraform"
    },
    var.tags,
  )
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# One user-assigned identity shared by every container app and job: pulls
# images from ACR and reads secrets from Key Vault. User-assigned (not
# system-assigned) so its role assignments exist BEFORE the apps are
# created -- a system identity only exists after its app does, which
# would make the very first revision fail to pull its image.
resource "azurerm_user_assigned_identity" "apps" {
  name                = "id-${local.name}-apps"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags
}

# ── Container registry ────────────────────────────────────────────────────

resource "azurerm_container_registry" "main" {
  name                = "cr${var.project_name}${var.environment}${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = var.acr_sku
  # Identity-based pulls/pushes only -- no shared admin password.
  admin_enabled = false
  tags          = local.tags
}

resource "azurerm_role_assignment" "apps_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.apps.principal_id
}

# ── Key Vault ─────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "main" {
  # Key Vault names are capped at 24 characters.
  name                       = "${trimsuffix(substr("kv-${local.name}", 0, 18), "-")}-${local.suffix}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = var.key_vault_purge_protection
  tags                       = local.tags
}

# Whoever runs `terraform apply` writes the secrets below.
resource "azurerm_role_assignment" "deployer_kv_secrets_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# The apps only ever read them.
resource "azurerm_role_assignment" "apps_kv_secrets_user" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.apps.principal_id
}

resource "random_password" "cookie_secret" {
  length  = 64
  special = false
}

resource "random_password" "payment_webhook_secret" {
  length  = 48
  special = false
}

locals {
  # Every runtime secret, stored in Key Vault and referenced (never copied)
  # by the container apps -- rotating one is a Key Vault update plus a new
  # revision, not a Terraform re-apply of plaintext values.
  secrets = {
    "cookie-secret"          = random_password.cookie_secret.result
    "payment-webhook-secret" = random_password.payment_webhook_secret.result
    "database-url-api"       = local.database_url_api
    "database-url-worker"    = local.database_url_worker
    "database-url-migrate"   = local.database_url_migrate
    "redis-url"              = local.redis_url
    "acs-connection-string"  = azurerm_communication_service.main.primary_connection_string
  }
}

resource "azurerm_key_vault_secret" "app" {
  for_each = local.secrets

  name         = each.key
  value        = each.value
  key_vault_id = azurerm_key_vault.main.id
  content_type = "text/plain"

  depends_on = [azurerm_role_assignment.deployer_kv_secrets_officer]
}

# ── CI/CD identity (optional) ─────────────────────────────────────────────

resource "azurerm_role_assignment" "ci_acr_push" {
  count                = var.ci_principal_object_id == null ? 0 : 1
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = var.ci_principal_object_id
}

# Needed to update container app images and start the migrate job.
resource "azurerm_role_assignment" "ci_rg_contributor" {
  count                = var.ci_principal_object_id == null ? 0 : 1
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = var.ci_principal_object_id
}
