terraform {
  required_version = ">= 1.6"
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

provider "aws" {
  region = var.region
}

module "homecloud" {
  source = "../../modules/homecloud"

  home_ids           = var.home_ids
  device_csrs        = var.device_csrs
  create_web_hosting = true
  # Creates its own Cognito pool, client, hosted UI domain and the "admin" group.
  allowed_groups = ["admin"]
}

output "api_url" { value = module.homecloud.api_url }
output "iot_endpoint" { value = module.homecloud.iot_endpoint }
output "thing_names" { value = module.homecloud.thing_names }
output "web_url" { value = module.homecloud.web_url }
output "web_bucket" { value = module.homecloud.web_bucket }
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
