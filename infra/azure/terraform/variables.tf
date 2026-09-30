variable "subscription_id" {
  description = "Azure subscription to deploy into (azurerm 4.x requires it explicitly)."
  type        = string
}

variable "location" {
  description = "Azure region for every resource, e.g. centralindia, eastus2, westeurope. Must offer Container Apps, Postgres Flexible Server and Azure Managed Redis."
  type        = string
  default     = "centralindia"
}

variable "project_name" {
  description = "Short lowercase name used as a prefix for every resource."
  type        = string
  default     = "flashsale"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.project_name))
    error_message = "project_name must be 3-12 lowercase letters/digits, starting with a letter (it becomes part of globally-unique names like the ACR and Key Vault)."
  }
}

variable "environment" {
  description = "Deployment environment name (e.g. prod, staging)."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z0-9]{2,8}$", var.environment))
    error_message = "environment must be 2-8 lowercase letters/digits."
  }
}

variable "image_tag" {
  description = <<-EOT
    Image tag (e.g. a git SHA) the api/worker/web/gateway container apps
    and the migrate job are CREATED with. Only used on first creation:
    after that, the CI pipeline (.github/workflows/azure-deploy.yml) owns
    image updates and Terraform ignores image drift (lifecycle
    ignore_changes in container-apps.tf). The images must already exist
    in ACR -- see docs/azure-deployment.md's bootstrap steps.
  EOT
  type        = string
}

variable "custom_domain" {
  description = "Optional public hostname (e.g. tickets.example.com) you will bind to the gateway app. Adds it to the API's CORS origins; binding the domain + managed certificate is a manual step (docs/azure-deployment.md). Leave null to use the gateway's default *.azurecontainerapps.io hostname."
  type        = string
  default     = null
}

variable "vnet_cidr" {
  description = "Address space of the VNet. Subnets are carved from it in network.tf."
  type        = string
  default     = "10.40.0.0/16"
}

# ── Postgres ──────────────────────────────────────────────────────────────

variable "postgres_sku" {
  description = "Postgres Flexible Server SKU. B_Standard_B2s allows ~429 connections -- enough for api (10/replica) x api_max_replicas + worker. Use a GP_ SKU (e.g. GP_Standard_D2ds_v5) for production load and to enable zone-redundant HA."
  type        = string
  default     = "B_Standard_B2s"
}

variable "postgres_version" {
  description = "Postgres major version."
  type        = string
  default     = "16"
}

variable "postgres_storage_mb" {
  description = "Allocated storage in MB (storage auto-grow is enabled)."
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time-restore window, 7-35 days."
  type        = number
  default     = 14
}

variable "postgres_zone_redundant_ha" {
  description = "Zone-redundant standby for Postgres. Requires a General Purpose or Memory Optimized SKU (not Burstable) and roughly doubles DB cost."
  type        = bool
  default     = false
}

# ── Redis ─────────────────────────────────────────────────────────────────

variable "redis_sku" {
  description = "Azure Managed Redis SKU. Balanced_B0 is the smallest; NoCluster (required by BullMQ's multi-key Lua scripts) is available on the smaller sizes -- see redis.tf."
  type        = string
  default     = "Balanced_B0"
}

variable "redis_high_availability" {
  description = "Replicated (HA) Managed Redis. Keep true for production -- sessions, locks, queues and the domain-event stream live here."
  type        = bool
  default     = true
}

# ── Email ─────────────────────────────────────────────────────────────────

variable "email_data_location" {
  description = "Data location for Azure Communication Services (e.g. \"India\", \"United States\", \"Europe\")."
  type        = string
  default     = "India"
}

# ── Scaling ───────────────────────────────────────────────────────────────

variable "api_min_replicas" {
  description = "Minimum api replicas. Keep >= 1: the api holds WebSocket connections and a cold start would drop live seat maps."
  type        = number
  default     = 1
}

variable "api_max_replicas" {
  description = "Maximum api replicas (HTTP-concurrency autoscaling). Each uses up to 10 Postgres connections."
  type        = number
  default     = 4
}

variable "web_min_replicas" {
  type    = number
  default = 1
}

variable "web_max_replicas" {
  type    = number
  default = 3
}

variable "gateway_min_replicas" {
  type    = number
  default = 1
}

variable "gateway_max_replicas" {
  type    = number
  default = 3
}

variable "worker_replicas" {
  description = "Worker replicas. Every worker job is safe to run on several replicas (consumer groups, status-guarded updates, row locks), but 1 is plenty for most loads."
  type        = number
  default     = 1
}

variable "key_vault_purge_protection" {
  description = "Key Vault purge protection. Recommended for production; note it prevents re-creating a vault with the same name for the soft-delete period after a destroy."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "ci_principal_object_id" {
  description = "Object ID of the service principal / managed identity GitHub Actions logs in as (OIDC federated credential). When set, it gets AcrPush on the registry and Contributor on the resource group -- exactly what .github/workflows/azure-deploy.yml needs, nothing subscription-wide. Leave null to assign roles yourself."
  type        = string
  default     = null
}

variable "acr_sku" {
  description = "Container registry SKU. Basic is enough for a demo; Standard adds storage and throughput headroom."
  type        = string
  default     = "Standard"
}
