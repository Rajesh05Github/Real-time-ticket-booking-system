output "public_url" {
  description = "Where the app is served (the gateway's HTTPS hostname, or your custom domain once bound)."
  value       = local.public_origin
}

output "gateway_default_hostname" {
  description = "Point your custom domain's CNAME here (docs/azure-deployment.md)."
  value       = local.gateway_fqdn
}

output "gateway_custom_domain_verification_id" {
  description = "Value for the asuid.<your-domain> TXT record when binding a custom domain."
  value       = azurerm_container_app_environment.main.custom_domain_verification_id
  sensitive   = true
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

# Names the CI workflow needs (set them as GitHub Actions variables --
# docs/azure-deployment.md lists which).
output "container_app_names" {
  value = {
    api     = azurerm_container_app.api.name
    worker  = azurerm_container_app.worker.name
    web     = azurerm_container_app.web.name
    gateway = azurerm_container_app.gateway.name
  }
}

output "migrate_job_name" {
  value = azurerm_container_app_job.migrate.name
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "email_sender" {
  description = "The From address OTP emails are sent from."
  value       = local.email_from
}

output "postgres_fqdn" {
  description = "Private hostname -- only resolvable inside the VNet."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}
