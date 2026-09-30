# Azure Communication Services Email -- the worker's EMAIL_PROVIDER=acs
# (apps/worker/src/providers/acs-email-provider.ts) sends OTP codes
# through this.
#
# An Azure-managed domain (xxxx.azurecomm.net) works immediately with no
# DNS setup, which is what this config provisions. Its sending quota is
# deliberately low; for real traffic add a custom domain (SPF/DKIM DNS
# records) and request a quota increase -- see docs/azure-deployment.md.

resource "azurerm_email_communication_service" "main" {
  name                = "acs-email-${local.name}-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.email_data_location
  tags                = local.tags
}

resource "azurerm_email_communication_service_domain" "azure_managed" {
  name              = "AzureManagedDomain"
  email_service_id  = azurerm_email_communication_service.main.id
  domain_management = "AzureManaged"
  tags              = local.tags
}

resource "azurerm_communication_service" "main" {
  name                = "acs-${local.name}-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.email_data_location
  tags                = local.tags
}

resource "azurerm_communication_service_email_domain_association" "main" {
  communication_service_id = azurerm_communication_service.main.id
  email_service_domain_id  = azurerm_email_communication_service_domain.azure_managed.id
}

locals {
  email_from = "DoNotReply@${azurerm_email_communication_service_domain.azure_managed.from_sender_domain}"
}
