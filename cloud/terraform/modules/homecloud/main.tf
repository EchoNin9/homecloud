data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

data "aws_iot_endpoint" "this" {
  endpoint_type = "iot:Data-ATS"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition
  homes      = toset(var.home_ids)

  create_pool  = var.existing_user_pool_id == null
  user_pool_id = local.create_pool ? aws_cognito_user_pool.this[0].id : var.existing_user_pool_id
  # A pool id is "{region}_{suffix}": derive the issuer region from it so pools in another region work.
  pool_region    = split("_", local.user_pool_id)[0]
  issuer         = "https://cognito-idp.${local.pool_region}.amazonaws.com/${local.user_pool_id}"
  client_ids     = local.create_pool ? [aws_cognito_user_pool_client.this[0].id] : var.existing_user_pool_client_ids
  cognito_domain = local.create_pool ? "${aws_cognito_user_pool_domain.this[0].domain}.auth.${local.region}.amazoncognito.com" : var.existing_cognito_domain

  cloudfront_url = var.create_web_hosting ? "https://${aws_cloudfront_distribution.web[0].domain_name}" : null
  # The custom domain is the web URL once its certificate is attached (web.tf), else CloudFront's.
  web_url = local.web_cert_arn != null ? "https://${local.web_domain}" : local.cloudfront_url
  web_urls = concat(
    [for u in var.web_callback_urls : u],
    local.cloudfront_url == null ? [] : ["${local.cloudfront_url}/"],
    local.web_domain == null ? [] : ["https://${local.web_domain}/"],
  )
  cors_origins = distinct([for u in local.web_urls : regex("^https?://[^/]+", u)])
  # Native (Android/iOS) apps sign in through the same public client with PKCE.
  # Their custom-scheme redirects are registered with Cognito but never used as CORS origins.
  auth_redirect_urls = concat(local.web_urls, var.native_redirect_uris)

  common_tags = merge({ "homecloud" = var.name_prefix }, var.tags)
}
