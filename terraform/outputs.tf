# ==============================================================================
# Terraform Outputs
# ==============================================================================

# --- Primary Region ---
output "primary_alb_dns" {
  description = "DNS name of the primary ALB"
  value       = module.alb_primary.alb_dns_name
}

output "primary_ecs_cluster" {
  description = "Name of the primary ECS cluster"
  value       = module.ecs_primary.cluster_name
}

output "primary_ecs_service" {
  description = "Name of the primary ECS service"
  value       = module.ecs_primary.service_name
}

# --- Secondary Region ---
output "secondary_alb_dns" {
  description = "DNS name of the secondary ALB"
  value       = module.alb_secondary.alb_dns_name
}

output "secondary_ecs_cluster" {
  description = "Name of the secondary ECS cluster"
  value       = module.ecs_secondary.cluster_name
}

output "secondary_ecs_service" {
  description = "Name of the secondary ECS service"
  value       = module.ecs_secondary.service_name
}

# --- DNS ---
output "route53_zone_id" {
  description = "Route 53 hosted zone ID (if configured)"
  value       = var.route53_zone_id
}

output "application_url" {
  description = "Application URL (if DNS configured)"
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "Use ALB DNS names above"
}

# --- DynamoDB ---
output "lock_table_name" {
  description = "DynamoDB lock table name for split-brain prevention"
  value       = aws_dynamodb_table.failover_locks.name
}

output "lock_table_arn" {
  description = "DynamoDB lock table ARN"
  value       = aws_dynamodb_table.failover_locks.arn
}
