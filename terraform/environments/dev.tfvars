# ==============================================================================
# Development Environment Variables
# ==============================================================================
# Minimal sizing for development and testing.
# Usage: terraform apply -var-file=environments/dev.tfvars
# ==============================================================================

project_name    = "kinetic-failover"
environment     = "dev"
primary_region  = "us-east-1"
secondary_region = "eu-west-1"

# Networking
primary_vpc_cidr         = "10.0.0.0/16"
secondary_vpc_cidr       = "10.1.0.0/16"
availability_zones_count = 2

# Container (REPLACE with your actual image)
container_image    = "nginx:latest"
container_port     = 80
health_check_path  = "/"

# ECS — minimal for dev
cpu            = 256
memory         = 512
desired_count  = 1
secondary_desired_count = 0

# DNS — leave empty to skip Route 53 setup
domain_name    = ""
route53_zone_id = ""

# DynamoDB
lock_table_name = "kinetic-failover-locks-dev"
