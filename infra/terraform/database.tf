resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id

  tags = local.common_tags
}

resource "aws_db_instance" "postgres" {
  identifier     = "${local.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = "17"

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "flashsale"
  username = "flashsale"
  password = random_password.postgres.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az = var.db_multi_az

  # A real production RDS instance keeps automated backups and a final
  # snapshot on deletion; both are turned off/skipped here on purpose --
  # this config was never applied against a real account (see
  # versions.tf), so there is no real data to protect, and leaving these
  # at their safe defaults would just make `terraform destroy` (used
  # constantly while iterating on THIS file) slower and noisier for no
  # benefit. Flip both before ever running this against a real
  # environment with real data.
  backup_retention_period = 0
  skip_final_snapshot     = true

  # Same reasoning as docker-compose.yml's postgres service: no
  # publicly-reachable endpoint at all, private-subnet-only, security
  # group scoped to ECS tasks exclusively (security-groups.tf).
  publicly_accessible = false

  tags = local.common_tags
}
