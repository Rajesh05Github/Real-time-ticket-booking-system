# Azure deployment for FLASHSALE -- see docs/azure-deployment.md for the
# architecture, the bootstrap order (images must exist in ACR before the
# first full apply), and what this config deliberately does not do.

terraform {
  required_version = ">= 1.7"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # >= 4.50 for azurerm_managed_redis's NoCluster clustering policy
      # (earlier 4.x releases rejected it); see redis.tf.
      version = "~> 4.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state. Create the storage account + container once (see
  # docs/azure-deployment.md, "Remote state"), then uncomment and fill in
  # before `terraform init`. Local state is fine for a first experiment
  # but holds every generated secret in plaintext on your disk.
  #
  # backend "azurerm" {
  #   resource_group_name  = "rg-flashsale-tfstate"
  #   storage_account_name = "stflashsaletfstate"
  #   container_name       = "tfstate"
  #   key                  = "flashsale-production.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "azurerm" {
  subscription_id = var.subscription_id

  features {
    key_vault {
      # Keep soft-deleted secrets recoverable on `terraform destroy`
      # instead of purging them.
      purge_soft_delete_on_destroy = false
    }
    resource_group {
      # Refuse to delete the resource group if something outside
      # Terraform was created in it.
      prevent_deletion_if_contains_resources = true
    }
  }
}
