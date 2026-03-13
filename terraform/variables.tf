# ==============================================================================
# Terraform Variables — Input Parameters
# ==============================================================================

# --- General ---
variable "project_name" {
  description = "Name of the project, used for resource naming and tagging"
  type        = string
  default     = "kinetic-failover"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

# --- Regions ---
variable "primary_region" {
  description = "Primary AWS region for the main workload"
  type        = string
  default     = "us-east-1"
}

variable "secondary_region" {
  description = "Secondary AWS region for failover"
  type        = string
  default     = "eu-west-1"
}

# --- Networking ---
variable "primary_vpc_cidr" {
  description = "CIDR block for the primary VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "secondary_vpc_cidr" {
  description = "CIDR block for the secondary VPC"
  type        = string
  default     = "10.1.0.0/16"
}

variable "availability_zones_count" {
  description = "Number of AZs to use in each region (2 or 3)"
  type        = number
  default     = 2
}

# --- Container ---
variable "container_image" {
  description = "Docker image URI for the application container (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com/my-app:latest)"
  type        = string
}

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 8080
}

variable "health_check_path" {
  description = "HTTP path for ALB health checks"
  type        = string
  default     = "/health"
}

# --- ECS ---
variable "cpu" {
  description = "CPU units for Fargate task (256, 512, 1024, 2048, 4096)"
  type        = number
  default     = 256
}

variable "memory" {
  description = "Memory (MiB) for Fargate task"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of ECS tasks in the primary region"
  type        = number
  default     = 2
}

variable "secondary_desired_count" {
  description = "Desired number of ECS tasks in the secondary region (0 = standby, scale up on failover)"
  type        = number
  default     = 0
}

# --- DNS ---
variable "domain_name" {
  description = "Domain name for the application (e.g., app.example.com)"
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 Hosted Zone ID for the domain. Leave empty to skip DNS setup."
  type        = string
  default     = ""
}

# --- DynamoDB (Split-Brain Lock) ---
variable "lock_table_name" {
  description = "Name of the DynamoDB table for split-brain locking"
  type        = string
  default     = "kinetic-failover-locks"
}
