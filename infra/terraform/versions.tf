# Phase 21: AWS deployment prep. See docs/aws-deployment.md for the full
# architecture writeup, why ECS Fargate (not EKS/EC2) was chosen, and what
# this config deliberately does NOT provision.
#
# NOT applied against a real AWS account as part of this project (a
# deliberate scope decision -- see docs/aws-deployment.md's "What this
# phase deliberately does not include"). Validated with `terraform init`
# + `terraform validate` (real HCL syntax/schema checking against the AWS
# provider's actual resource schemas) via the official Docker image, the
# same "no local install needed" pattern Phase 18 used for k6.

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No backend block: a real deployment needs a real, already-provisioned
  # S3 bucket + DynamoDB lock table for remote state, and that's a
  # decision (which AWS account, which bucket name, who else has access)
  # this project can't make on your behalf. Uncomment and fill in before
  # a real `terraform init`:
  #
  # backend "s3" {
  #   bucket         = "your-terraform-state-bucket"
  #   key            = "flashsale/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "your-terraform-lock-table"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}
