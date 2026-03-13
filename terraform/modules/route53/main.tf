# ==============================================================================
# Route 53 Module — DNS Failover Routing & Health Checks
# ==============================================================================

variable "project_name" { type = string }
variable "environment" { type = string }
variable "domain_name" { type = string }
variable "zone_id" { type = string }
variable "primary_alb_dns" { type = string }
variable "primary_alb_zone_id" { type = string }
variable "secondary_alb_dns" { type = string }
variable "secondary_alb_zone_id" { type = string }
variable "health_check_path" { type = string }
variable "container_port" { type = number }

# --- Health Check for Primary ALB ---
resource "aws_route53_health_check" "primary" {
  fqdn              = var.primary_alb_dns
  port              = 80
  type              = "HTTP"
  resource_path     = var.health_check_path
  failure_threshold = 3
  request_interval  = 10

  tags = {
    Name = "${var.project_name}-${var.environment}-primary-health-check"
  }
}

# --- Health Check for Secondary ALB ---
resource "aws_route53_health_check" "secondary" {
  fqdn              = var.secondary_alb_dns
  port              = 80
  type              = "HTTP"
  resource_path     = var.health_check_path
  failure_threshold = 3
  request_interval  = 10

  tags = {
    Name = "${var.project_name}-${var.environment}-secondary-health-check"
  }
}

# --- Primary Failover Record ---
resource "aws_route53_record" "primary" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "A"

  failover_routing_policy {
    type = "PRIMARY"
  }

  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id

  alias {
    name                   = var.primary_alb_dns
    zone_id                = var.primary_alb_zone_id
    evaluate_target_health = true
  }
}

# --- Secondary Failover Record ---
resource "aws_route53_record" "secondary" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "A"

  failover_routing_policy {
    type = "SECONDARY"
  }

  set_identifier  = "secondary"
  health_check_id = aws_route53_health_check.secondary.id

  alias {
    name                   = var.secondary_alb_dns
    zone_id                = var.secondary_alb_zone_id
    evaluate_target_health = true
  }
}

# --- Outputs ---
output "primary_health_check_id" {
  value = aws_route53_health_check.primary.id
}

output "secondary_health_check_id" {
  value = aws_route53_health_check.secondary.id
}
