locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # Fargate needs at least 2 AZs for the ALB regardless of
  # availability_zone_count, so this is floor-2'd defensively.
  az_count = max(var.availability_zone_count, 2)

  # CORS_ORIGIN: the real domain over https if one was given, otherwise
  # fall back to the ALB's own DNS name (useful for a quick HTTP-only
  # test deploy with no domain -- see acm.tf/alb.tf for the http-only
  # fallback path).
  computed_cors_origin = var.domain_name != null ? "https://${var.domain_name}" : "http://${aws_lb.main.dns_name}"
}
