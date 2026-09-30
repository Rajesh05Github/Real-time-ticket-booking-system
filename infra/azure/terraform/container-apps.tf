# Topology (docs/azure-deployment.md):
#
#   Internet --HTTPS--> gateway (external ingress, managed TLS)
#                         /api/*  --> api    (internal ingress)
#                         /*      --> web    (internal ingress)
#   worker  (no ingress)       -- background jobs + stream consumers
#   migrate (manual job)       -- `prisma migrate deploy`, run by CI
#
# The gateway plays exactly the role infra/nginx does in docker-compose
# (one origin for web + api, so session/CSRF cookies are first-party and
# the WebSocket needs no CORS), which Container Apps' own ingress cannot
# do by itself: it routes by hostname, not by path.

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.name}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  # Apps are still individually internal/external via their ingress; this
  # only controls whether the environment's load balancer is public.
  internal_load_balancer_enabled = false

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [infrastructure_resource_group_name]
  }
}

locals {
  registry_server = azurerm_container_registry.main.login_server
  image           = { for app in ["api", "worker", "web", "gateway"] : app => "${local.registry_server}/flashsale-${app}:${var.image_tag}" }

  # App hostnames are deterministic (<app>.<env domain>, internal apps
  # under .internal.), so they are computed from names rather than read
  # back from the apps: the api needs the gateway hostname (CORS) and the
  # gateway needs the api hostname (upstream), which would otherwise be a
  # dependency cycle.
  app_names = {
    api     = "ca-${local.name}-api"
    worker  = "ca-${local.name}-worker"
    web     = "ca-${local.name}-web"
    gateway = "ca-${local.name}-gateway"
  }
  env_domain        = azurerm_container_app_environment.main.default_domain
  gateway_fqdn      = "${local.app_names.gateway}.${local.env_domain}"
  api_internal_fqdn = "${local.app_names.api}.internal.${local.env_domain}"
  web_internal_fqdn = "${local.app_names.web}.internal.${local.env_domain}"

  public_origin = var.custom_domain != null ? "https://${var.custom_domain}" : "https://${local.gateway_fqdn}"
  # Both the custom domain (when set) and the default hostname, so the app
  # keeps working on the default URL while DNS for the custom one settles.
  cors_origins = join(",", compact([
    var.custom_domain != null ? "https://${var.custom_domain}" : "",
    "https://${local.gateway_fqdn}",
  ]))

  kv_secret_ids = { for name, secret in azurerm_key_vault_secret.app : name => secret.versionless_id }
}

# ── api ───────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "api" {
  name                         = local.app_names.api
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry_server
    identity = azurerm_user_assigned_identity.apps.id
  }

  dynamic "secret" {
    for_each = toset(["cookie-secret", "payment-webhook-secret", "database-url-api", "redis-url"])
    content {
      name                = secret.value
      key_vault_secret_id = local.kv_secret_ids[secret.value]
      identity            = azurerm_user_assigned_identity.apps.id
    }
  }

  ingress {
    # Internal: reachable only from inside the environment (the gateway
    # and web's server-side fetches). Plain HTTP inside the environment
    # is fine -- TLS terminates at the gateway's public ingress.
    external_enabled           = false
    allow_insecure_connections = true
    target_port                = 4000
    transport                  = "auto" # HTTP/1.1 upgrade for the live WebSocket

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas
    # Matches apps/api's SHUTDOWN_TIMEOUT_MS (10s) with headroom, so
    # in-flight requests drain before SIGKILL.
    termination_grace_period_seconds = 30

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "50"
    }

    container {
      name   = "api"
      image  = local.image["api"]
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "4000"
      }
      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "CORS_ORIGIN"
        value = local.cors_origins
      }
      env {
        name  = "SHUTDOWN_TIMEOUT_MS"
        value = "10000"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url-api"
      }
      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }
      env {
        name        = "COOKIE_SECRET"
        secret_name = "cookie-secret"
      }
      env {
        name        = "PAYMENT_WEBHOOK_SECRET"
        secret_name = "payment-webhook-secret"
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 4000
        path             = "/health"
        initial_delay    = 10
        interval_seconds = 15
      }

      readiness_probe {
        # /ready checks Postgres + Redis; a replica that can't reach them
        # stops receiving traffic instead of serving 500s.
        transport        = "HTTP"
        port             = 4000
        path             = "/ready"
        interval_seconds = 10
        timeout          = 5
      }
    }
  }

  tags = local.tags

  lifecycle {
    # CI (.github/workflows/azure-deploy.yml) rolls out new images; see
    # var.image_tag.
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.apps_acr_pull,
    azurerm_role_assignment.apps_kv_secrets_user,
  ]
}

# ── worker ────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "worker" {
  name                         = local.app_names.worker
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry_server
    identity = azurerm_user_assigned_identity.apps.id
  }

  dynamic "secret" {
    for_each = toset(["database-url-worker", "redis-url", "acs-connection-string"])
    content {
      name                = secret.value
      key_vault_secret_id = local.kv_secret_ids[secret.value]
      identity            = azurerm_user_assigned_identity.apps.id
    }
  }

  template {
    # No ingress and no HTTP traffic to scale on: a fixed replica count.
    min_replicas = var.worker_replicas
    max_replicas = var.worker_replicas
    # apps/worker's SHUTDOWN_TIMEOUT_MS is 15s (BullMQ jobs finish, stream
    # reads time out) -- give it room before SIGKILL.
    termination_grace_period_seconds = 45

    container {
      name   = "worker"
      image  = local.image["worker"]
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "WORKER_CONCURRENCY"
        value = "5"
      }
      env {
        name  = "WORKER_PORT"
        value = "4100"
      }
      env {
        name  = "SHUTDOWN_TIMEOUT_MS"
        value = "15000"
      }
      env {
        name  = "EMAIL_PROVIDER"
        value = "acs"
      }
      env {
        name  = "EMAIL_FROM"
        value = local.email_from
      }
      env {
        name        = "ACS_EMAIL_CONNECTION_STRING"
        secret_name = "acs-connection-string"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url-worker"
      }
      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }

      # apps/worker/src/health-server.ts -- the Phase 20 liveness endpoint
      # built for exactly this.
      liveness_probe {
        transport        = "HTTP"
        port             = 4100
        path             = "/health"
        initial_delay    = 10
        interval_seconds = 15
      }
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.apps_acr_pull,
    azurerm_role_assignment.apps_kv_secrets_user,
    azurerm_communication_service_email_domain_association.main,
  ]
}

# ── web ───────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "web" {
  name                         = local.app_names.web
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry_server
    identity = azurerm_user_assigned_identity.apps.id
  }

  ingress {
    external_enabled           = false
    allow_insecure_connections = true
    target_port                = 3000

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                     = var.web_min_replicas
    max_replicas                     = var.web_max_replicas
    termination_grace_period_seconds = 30

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "50"
    }

    container {
      name   = "web"
      image  = local.image["web"]
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "3000"
      }
      env {
        name  = "HOSTNAME"
        value = "0.0.0.0"
      }
      # Server Components fetch the api directly over the environment's
      # internal network (apps/web/src/lib/api/config.ts); the browser
      # bundle is built with an empty NEXT_PUBLIC_API_URL and uses
      # same-origin relative URLs through the gateway.
      env {
        name  = "API_INTERNAL_URL"
        value = "http://${local.api_internal_fqdn}"
      }

      liveness_probe {
        transport        = "TCP"
        port             = 3000
        initial_delay    = 10
        interval_seconds = 15
      }
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [azurerm_role_assignment.apps_acr_pull]
}

# ── gateway (the only public app) ─────────────────────────────────────────

resource "azurerm_container_app" "gateway" {
  name                         = local.app_names.gateway
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry_server
    identity = azurerm_user_assigned_identity.apps.id
  }

  ingress {
    external_enabled = true
    # HTTP is redirected to HTTPS by Container Apps itself -- the api's
    # Secure cookies would be silently dropped over plain HTTP
    # (docs/production-hardening.md).
    allow_insecure_connections = false
    target_port                = 8080
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                     = var.gateway_min_replicas
    max_replicas                     = var.gateway_max_replicas
    termination_grace_period_seconds = 30

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "200"
    }

    container {
      name   = "gateway"
      image  = local.image["gateway"]
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "API_UPSTREAM_HOST"
        value = local.api_internal_fqdn
      }
      env {
        name  = "WEB_UPSTREAM_HOST"
        value = local.web_internal_fqdn
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 8080
        path             = "/gateway-health"
        interval_seconds = 15
      }
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [azurerm_role_assignment.apps_acr_pull]
}

# ── migrate job ───────────────────────────────────────────────────────────

# Runs `prisma migrate deploy` from INSIDE the VNet (Postgres has no
# public endpoint). Uses the api image, which carries the Prisma CLI,
# schema and migrations. Started by CI before every rollout; also usable
# for one-off operations via a command override, e.g. promote-admin.ts
# (docs/azure-deployment.md).
resource "azurerm_container_app_job" "migrate" {
  name                         = "caj-${local.name}-migrate"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 1

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry_server
    identity = azurerm_user_assigned_identity.apps.id
  }

  secret {
    name                = "database-url-migrate"
    key_vault_secret_id = local.kv_secret_ids["database-url-migrate"]
    identity            = azurerm_user_assigned_identity.apps.id
  }

  template {
    container {
      name    = "migrate"
      image   = local.image["api"]
      cpu     = 0.5
      memory  = "1Gi"
      command = ["sh", "-c", "cd packages/database && ./node_modules/.bin/prisma migrate deploy"]

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url-migrate"
      }
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.apps_acr_pull,
    azurerm_role_assignment.apps_kv_secrets_user,
  ]
}
