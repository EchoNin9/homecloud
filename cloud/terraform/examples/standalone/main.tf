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

variable "home_ids" {
  type    = list(string)
  default = ["home"]
}

variable "device_csrs" {
  description = "Optional homeId => CSR PEM so the private key never enters state."
  type        = map(string)
  default     = {}
}

variable "device_csr_files" {
  description = "Optional homeId => path to a CSR file (recommended; see docs/first-deploy.md). Merged over device_csrs."
  type        = map(string)
  default     = {}
}

variable "history_utc_offset_hours" {
  description = "Where daily history rollups split: fixed UTC offset in hours (e.g. -7). See the module variable."
  type        = number
  default     = 0
}

provider "aws" {
  region = var.region
}

module "homecloud" {
  source = "../../modules/homecloud"

  home_ids           = var.home_ids
  device_csrs        = merge(var.device_csrs, { for k, p in var.device_csr_files : k => file(p) })
  create_web_hosting = true
  # Creates its own Cognito pool, client, hosted UI domain and the "admin" group.
  allowed_groups           = ["admin"]
  history_utc_offset_hours = var.history_utc_offset_hours
}

output "api_url" { value = module.homecloud.api_url }
output "iot_endpoint" { value = module.homecloud.iot_endpoint }
output "thing_names" { value = module.homecloud.thing_names }
output "web_url" { value = module.homecloud.web_url }
output "web_bucket" { value = module.homecloud.web_bucket }
output "web_distribution_id" { value = module.homecloud.web_distribution_id }
output "table_name" { value = module.homecloud.table_name }
output "user_pool_id" { value = module.homecloud.user_pool_id }
output "user_pool_client_id" { value = module.homecloud.user_pool_client_id }
output "cognito_domain" { value = module.homecloud.cognito_domain }

output "certificate_pems" {
  value     = module.homecloud.certificate_pems
  sensitive = true
}

output "private_keys" {
  value     = module.homecloud.private_keys
  sensitive = true
}
