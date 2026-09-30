# Only created when a real domain is supplied (var.domain_name) -- ACM's
# DNS validation needs a real DNS zone to place a validation record in,
# which this config deliberately does NOT assume is Route53 (you may
# already have DNS hosted elsewhere). Without a domain, alb.tf falls back
# to an HTTP-only listener so `terraform apply` still produces something
# reachable for a quick test.
#
# If your DNS IS in Route53, the commented block below shows the extra
# ~10 lines to fully automate validation; otherwise, after `apply`,
# create the CNAME record ACM asks for by hand (or via whatever DNS
# provider you use) and wait for `aws_acm_certificate_validation` to
# report ISSUED.

resource "aws_acm_certificate" "main" {
  count = var.domain_name != null ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.common_tags
}

# # Route53-automated validation (uncomment if your zone is in Route53):
# data "aws_route53_zone" "main" {
#   count = var.domain_name != null ? 1 : 0
#   name  = var.domain_name
# }
#
# resource "aws_route53_record" "cert_validation" {
#   for_each = var.domain_name != null ? {
#     for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.domain_name => {
#       name   = dvo.resource_record_name
#       record = dvo.resource_record_value
#       type   = dvo.resource_record_type
#     }
#   } : {}
#
#   zone_id = data.aws_route53_zone.main[0].zone_id
#   name    = each.value.name
#   type    = each.value.type
#   records = [each.value.record]
#   ttl     = 60
# }
#
# resource "aws_acm_certificate_validation" "main" {
#   count                   = var.domain_name != null ? 1 : 0
#   certificate_arn         = aws_acm_certificate.main[0].arn
#   validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
# }
