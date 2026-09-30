variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used as a prefix for every resource and tag."
  type        = string
  default     = "flashsale"
}

variable "environment" {
  description = "Deployment environment name (e.g. production, staging)."
  type        = string
  default     = "production"
}

variable "domain_name" {
  description = <<-EOT
    A REAL, publicly-resolvable domain name you control, used for the ACM
    certificate (docs/aws-deployment.md explains why this can't be
    "localhost" the way Phase 20's self-signed Nginx cert was). ACM's
    DNS validation record has to be created wherever this domain's actual
    DNS is hosted, which this config does not assume is Route53 (see
    acm.tf) -- leave this unset (null) to skip ACM/HTTPS entirely and
    deploy the ALB on plain HTTP only, e.g. for a quick throwaway test.
  EOT
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zone_count" {
  description = "How many AZs to spread public/private subnets across. 2 is the minimum for an ALB and a Multi-AZ-capable RDS instance."
  type        = number
  default     = 2
}

variable "api_image_tag" {
  description = "Tag of the @flashsale/api image in ECR to deploy (e.g. a git SHA from CI)."
  type        = string
  default     = "latest"
}

variable "worker_image_tag" {
  description = "Tag of the @flashsale/worker image in ECR to deploy."
  type        = string
  default     = "latest"
}

variable "web_image_tag" {
  description = "Tag of the @flashsale/web image in ECR to deploy."
  type        = string
  default     = "latest"
}

variable "api_desired_count" {
  description = "Number of api Fargate tasks to run. >1 is what actually exercises Phase 20's per-process connection_limit tuning being additive across replicas -- see docs/aws-deployment.md."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Number of worker Fargate tasks. Every consumer this project builds (Phase 11/16's Streams consumer groups, BullMQ workers) is already designed to run more than one replica -- see docs/streams.md's consumer-name-per-process note -- this is the first place that ever actually happens."
  type        = number
  default     = 2
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  description = "RDS allocated storage in GB."
  type        = number
  default     = 20
}

variable "db_multi_az" {
  description = "Whether RDS runs Multi-AZ (a real production default; false here to match this project's explicit cost-consciousness -- see docs/aws-deployment.md)."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "cors_origin" {
  description = "Comma-separated allowed CORS origins for apps/api (mirrors the CORS_ORIGIN env var docker-compose.yml already sets)."
  type        = string
  default     = "" # filled in from the domain name in locals.tf once known
}
