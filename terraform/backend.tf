# ==============================================================================
# Terraform Backend — S3 + DynamoDB for State Locking
# ==============================================================================
# IMPORTANT: You must create the S3 bucket and DynamoDB table manually first,
# or comment this out for initial development. Uncomment when ready.
# ==============================================================================

# terraform {
#   backend "s3" {
#     bucket         = "kinetic-failover-terraform-state"
#     key            = "infrastructure/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "kinetic-failover-terraform-locks"
#     encrypt        = true
#   }
# }
