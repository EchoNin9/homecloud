# Plug homecloud into a stack that already owns a Cognito pool.
# Shaped after echo9's funkedupshift (infra/main.tf): it exposes outputs
# `cognitoUserPoolId` and `cognitoClientId`, and uses the groups admin / manager / user.
terraform {
  required_version = ">= 1.10" # OpenTofu >= 1.10 (or Terraform >= 1.10) for S3 native locking

  # Remote state in S3. Settings live in backend.hcl (copy backend.hcl.example):
  #   tofu init -backend-config=backend.hcl
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "consumer_state_bucket" {
  description = "S3 bucket holding the consumer stack's Terraform state."
  type        = string
}

variable "consumer_state_key" {
  type    = string
  default = "terraform.tfstate"
}

variable "consumer_site_url" {
  description = "Origin of the consumer's SPA (added to API CORS), e.g. https://app.example.com"
  type        = string
}

provider "aws" {
  region = var.region
}

# Read the pool + client straight from the other stack's outputs (read-only).
data "terraform_remote_state" "consumer" {
  backend = "s3"
  config = {
    bucket = var.consumer_state_bucket
    key    = var.consumer_state_key
    region = var.region
  }
}

module "homecloud" {
  source = "../../modules/homecloud"
  # In your own stack:
  # source = "github.com/EchoNin9/homecloud//cloud/terraform/modules/homecloud?ref=v0.1.0"

  home_ids = ["home"]

  existing_user_pool_id         = data.terraform_remote_state.consumer.outputs.cognitoUserPoolId
  existing_user_pool_client_ids = [data.terraform_remote_state.consumer.outputs.cognitoClientId]

  # funkedupshift's groups are admin / manager / user; only admins may touch the house.
  allowed_groups = ["admin"]

  # The consumer already has a SPA: no hosting here, just allow its origin through CORS.
  create_web_hosting = false
  web_callback_urls  = [var.consumer_site_url]
}

output "api_url" { value = module.homecloud.api_url }
output "iot_endpoint" { value = module.homecloud.iot_endpoint }
output "thing_names" { value = module.homecloud.thing_names }

output "certificate_pems" {
  value     = module.homecloud.certificate_pems
  sensitive = true
}

output "private_keys" {
  value     = module.homecloud.private_keys
  sensitive = true
}
