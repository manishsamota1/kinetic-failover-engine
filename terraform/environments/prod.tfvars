# ==============================================================================
# Production Environment Variables
# ==============================================================================
# Production sizing with higher resource allocation.
# Usage: terraform apply -var-file=environments/prod.tfvars
# ==============================================================================

project_name     = "kinetic-failover"
environment      = "prod"
primary_region   = "us-east-1"
secondary_region = "eu-west-1"

# Networking
primary_vpc_cidr         = "10.10.0.0/16"
secondary_vpc_cidr       = "10.11.0.0/16"
availability_zones_count = 3

# Container (REPLACE with your actual production image)
container_image   = "YOUR_ECR_REPO_URI:latest"
container_port    = 8080
health_check_path = "/health"

# ECS — production sizing
cpu                     = 1024
memory                  = 2048
desired_count           = 3
secondary_desired_count = 0

# DNS (REPLACE with your actual domain)
domain_name     = "app.yourdomain.com"
route53_zone_id = "YOUR_HOSTED_ZONE_ID"

# DynamoDB
lock_table_name = "kinetic-failover-locks-prod"
