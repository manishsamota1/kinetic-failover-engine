# ==============================================================================
# ALB Module — Application Load Balancer with Health Checks
# ==============================================================================

variable "project_name" { type = string }
variable "environment" { type = string }
variable "region_label" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "container_port" { type = number }
variable "health_check_path" { type = string }

# --- Security Group for ALB ---
resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-${var.environment}-${var.region_label}-alb-"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-${var.region_label}-alb-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Application Load Balancer ---
resource "aws_lb" "main" {
  name               = "${var.project_name}-${var.region_label}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = false

  tags = {
    Name = "${var.project_name}-${var.environment}-${var.region_label}-alb"
  }
}

# --- Target Group ---
resource "aws_lb_target_group" "main" {
  name        = "${var.project_name}-${var.region_label}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 10
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200-299"
  }

  deregistration_delay = 30

  tags = {
    Name = "${var.project_name}-${var.environment}-${var.region_label}-tg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- HTTP Listener (port 80) ---
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }
}

# --- Outputs ---
output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_zone_id" {
  value = aws_lb.main.zone_id
}

output "alb_arn" {
  value = aws_lb.main.arn
}

output "alb_arn_suffix" {
  value = aws_lb.main.arn_suffix
}

output "target_group_arn" {
  value = aws_lb_target_group.main.arn
}

output "security_group_id" {
  value = aws_security_group.alb.id
}
