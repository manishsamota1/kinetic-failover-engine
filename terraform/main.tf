# ==============================================================================
# Terraform Main — Root Module Composition
# ==============================================================================
# Orchestrates all sub-modules for both primary and secondary regions.
# ==============================================================================

# --- Data Sources ---
data "aws_availability_zones" "primary" {
  state = "available"
}

data "aws_availability_zones" "secondary" {
  provider = aws.secondary
  state    = "available"
}

# ==============================================================================
# PRIMARY REGION
# ==============================================================================

module "vpc_primary" {
  source = "./modules/vpc"

  project_name = var.project_name
  environment  = var.environment
  region_label = "primary"
  vpc_cidr     = var.primary_vpc_cidr
  az_count     = var.availability_zones_count
  azs          = slice(data.aws_availability_zones.primary.names, 0, var.availability_zones_count)
}

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
  environment  = var.environment
}

module "alb_primary" {
  source = "./modules/alb"

  project_name      = var.project_name
  environment       = var.environment
  region_label      = "primary"
  vpc_id            = module.vpc_primary.vpc_id
  public_subnet_ids = module.vpc_primary.public_subnet_ids
  container_port    = var.container_port
  health_check_path = var.health_check_path
}

module "ecs_primary" {
  source = "./modules/ecs"

  project_name          = var.project_name
  environment           = var.environment
  region_label          = "primary"
  vpc_id                = module.vpc_primary.vpc_id
  private_subnet_ids    = module.vpc_primary.private_subnet_ids
  container_image       = var.container_image
  container_port        = var.container_port
  cpu                   = var.cpu
  memory                = var.memory
  desired_count         = var.desired_count
  target_group_arn      = module.alb_primary.target_group_arn
  execution_role_arn    = module.iam.ecs_execution_role_arn
  task_role_arn         = module.iam.ecs_task_role_arn
  alb_security_group_id = module.alb_primary.security_group_id
}

# ==============================================================================
# SECONDARY REGION
# ==============================================================================

module "vpc_secondary" {
  source = "./modules/vpc"

  providers = {
    aws = aws.secondary
  }

  project_name = var.project_name
  environment  = var.environment
  region_label = "secondary"
  vpc_cidr     = var.secondary_vpc_cidr
  az_count     = var.availability_zones_count
  azs          = slice(data.aws_availability_zones.secondary.names, 0, var.availability_zones_count)
}

module "iam_secondary" {
  source = "./modules/iam"

  providers = {
    aws = aws.secondary
  }

  project_name = var.project_name
  environment  = var.environment
}

module "alb_secondary" {
  source = "./modules/alb"

  providers = {
    aws = aws.secondary
  }

  project_name      = var.project_name
  environment       = var.environment
  region_label      = "secondary"
  vpc_id            = module.vpc_secondary.vpc_id
  public_subnet_ids = module.vpc_secondary.public_subnet_ids
  container_port    = var.container_port
  health_check_path = var.health_check_path
}

module "ecs_secondary" {
  source = "./modules/ecs"

  providers = {
    aws = aws.secondary
  }

  project_name          = var.project_name
  environment           = var.environment
  region_label          = "secondary"
  vpc_id                = module.vpc_secondary.vpc_id
  private_subnet_ids    = module.vpc_secondary.private_subnet_ids
  container_image       = var.container_image
  container_port        = var.container_port
  cpu                   = var.cpu
  memory                = var.memory
  desired_count         = var.secondary_desired_count
  target_group_arn      = module.alb_secondary.target_group_arn
  execution_role_arn    = module.iam_secondary.ecs_execution_role_arn
  task_role_arn         = module.iam_secondary.ecs_task_role_arn
  alb_security_group_id = module.alb_secondary.security_group_id
}

# ==============================================================================
# DNS & HEALTH CHECKS
# ==============================================================================

module "route53" {
  source = "./modules/route53"

  count = var.route53_zone_id != "" ? 1 : 0

  project_name          = var.project_name
  environment           = var.environment
  domain_name           = var.domain_name
  zone_id               = var.route53_zone_id
  primary_alb_dns       = module.alb_primary.alb_dns_name
  primary_alb_zone_id   = module.alb_primary.alb_zone_id
  secondary_alb_dns     = module.alb_secondary.alb_dns_name
  secondary_alb_zone_id = module.alb_secondary.alb_zone_id
  health_check_path     = var.health_check_path
  container_port        = var.container_port
}

# ==============================================================================
# MONITORING
# ==============================================================================

module "monitoring_primary" {
  source = "./modules/monitoring"

  project_name     = var.project_name
  environment      = var.environment
  region_label     = "primary"
  alb_arn_suffix   = module.alb_primary.alb_arn_suffix
  ecs_cluster_name = module.ecs_primary.cluster_name
  ecs_service_name = module.ecs_primary.service_name
}

module "monitoring_secondary" {
  source = "./modules/monitoring"

  providers = {
    aws = aws.secondary
  }

  project_name     = var.project_name
  environment      = var.environment
  region_label     = "secondary"
  alb_arn_suffix   = module.alb_secondary.alb_arn_suffix
  ecs_cluster_name = module.ecs_secondary.cluster_name
  ecs_service_name = module.ecs_secondary.service_name
}

# ==============================================================================
# DYNAMODB LOCK TABLE (for split-brain prevention)
# ==============================================================================

resource "aws_dynamodb_table" "failover_locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "lockId"

  attribute {
    name = "lockId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    Name = "${var.project_name}-failover-locks"
  }
}
