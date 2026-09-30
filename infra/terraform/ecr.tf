# One repo per deployable image -- matches infra/docker/*.Dockerfile
# exactly (api, worker, web). A real CI pipeline builds each Dockerfile,
# tags it (e.g. with the git SHA), and `docker push`es here; this
# project's own build-and-push step is deliberately not part of this
# Terraform config -- provisioning infrastructure and building/publishing
# application images are different concerns with different lifecycles
# (see docs/aws-deployment.md).

resource "aws_ecr_repository" "api" {
  name                 = "${var.project_name}/api"
  image_tag_mutability = "IMMUTABLE" # a given tag (e.g. a git SHA) should never silently point at different bytes later

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.common_tags
}

resource "aws_ecr_repository" "worker" {
  name                 = "${var.project_name}/worker"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.common_tags
}

resource "aws_ecr_repository" "web" {
  name                 = "${var.project_name}/web"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.common_tags
}

# Keeps each repo from growing unbounded -- retains the most recent 20
# images per repo, expires the rest. 20 is generous headroom for
# debugging a recent regression while still bounding storage cost.
resource "aws_ecr_lifecycle_policy" "expire_old_images" {
  for_each = {
    api    = aws_ecr_repository.api.name
    worker = aws_ecr_repository.worker.name
    web    = aws_ecr_repository.web.name
  }

  repository = each.value

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the most recent 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
