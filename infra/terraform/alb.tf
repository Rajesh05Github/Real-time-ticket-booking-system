# The ALB takes over BOTH jobs Phase 20's Nginx container did locally --
# TLS termination and path-based routing (/api/* -> api, everything else
# -> web) -- see docs/production-hardening.md's own note that a real AWS
# deployment would most plausibly terminate TLS at the load-balancer
# layer rather than in an Nginx container, and docs/aws-deployment.md for
# why this config doesn't run an Nginx ECS service at all: the ALB is a
# managed, HA replacement for exactly what that container was doing, not
# an addition alongside it.

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  tags = local.common_tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api-tg"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # required for Fargate -- there's no static EC2 instance to register by ID

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    # apps/web has no dedicated health route yet (it's still the skeleton
    # Next.js app the phase list hasn't reached) -- the root page
    # returning 200 is the only signal currently available.
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = local.common_tags
}

# HTTPS listener only when a real cert exists; otherwise HTTP serves
# everything directly (see acm.tf's header comment on why a domain-less
# quick test can't get HTTPS at all -- ACM needs a real domain).
resource "aws_lb_listener" "https" {
  count = var.domain_name != null ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.main[0].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "https_api" {
  count = var.domain_name != null ? 1 : 0

  listener_arn = aws_lb_listener.https[0].arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      # apps/api's own routes already live under /api/v1 (section 32) --
      # same "forward as-is, no prefix stripping" behavior as Nginx's
      # `location /api/` block.
      values = ["/api/*"]
    }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Redirect to HTTPS if we have a cert (mirrors Phase 20's Nginx
  # redirect exactly); otherwise this IS the only listener, so it has to
  # actually serve traffic instead of redirecting to a port nothing is
  # listening on.
  dynamic "default_action" {
    for_each = var.domain_name != null ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = var.domain_name == null ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.web.arn
    }
  }
}

resource "aws_lb_listener_rule" "http_api" {
  count = var.domain_name == null ? 1 : 0

  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}
