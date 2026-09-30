output "alb_dns_name" {
  description = "The ALB's own DNS name. Point your domain's CNAME/ALIAS record here, or hit it directly for a domain-less test deploy (http:// only in that case -- see acm.tf)."
  value       = aws_lb.main.dns_name
}

output "ecr_repository_urls" {
  description = "docker push targets -- tag each Dockerfile's build output as `<url>:<tag>` (the tag api_image_tag/worker_image_tag/web_image_tag point at) and push before the ECS services can pull anything."
  value = {
    api    = aws_ecr_repository.api.repository_url
    worker = aws_ecr_repository.worker.repository_url
    web    = aws_ecr_repository.web.repository_url
  }
}

output "rds_endpoint" {
  description = "Postgres endpoint (private -- only reachable from inside the VPC, i.e. not useful for `psql` from your laptop without a bastion/SSM tunnel)."
  value       = aws_db_instance.postgres.endpoint
}

output "redis_endpoint" {
  description = "Redis endpoint (private, same reachability caveat as rds_endpoint)."
  value       = aws_elasticache_cluster.main.cache_nodes[0].address
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
