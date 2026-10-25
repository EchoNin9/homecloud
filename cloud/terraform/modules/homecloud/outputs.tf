output "api_url" {
  description = "Base URL of the HTTP API (routes live under /v1)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "iot_endpoint" {
  description = "MQTT endpoint (iot:Data-ATS) for the NAS bridge. TLS 8883, client id = thing name."
  value       = data.aws_iot_endpoint.this.endpoint_address
}

output "thing_names" {
  description = "homeId => IoT thing name (= MQTT client id)."
  value       = { for h, t in aws_iot_thing.home : h => t.name }
}

output "certificate_pems" {
  description = "homeId => device certificate PEM."
  value       = { for h, c in aws_iot_certificate.home : h => c.certificate_pem }
  sensitive   = true
}

output "private_keys" {
  description = "homeId => private key PEM, ONLY for homes without a CSR. These are stored in Terraform state."
  value       = { for h, c in aws_iot_certificate.home : h => c.private_key if !contains(keys(var.device_csrs), h) }
  sensitive   = true
}

output "user_pool_id" {
  value = local.user_pool_id
}

output "user_pool_client_id" {
  description = "Created client id, or the first existing_user_pool_client_ids entry."
  value       = local.client_ids[0]
}

output "cognito_domain" {
  description = "Hosted UI host (empty for an existing pool unless existing_cognito_domain is set)."
  value       = local.cognito_domain
}

output "web_url" {
  value = local.web_url
}

output "web_bucket" {
  value = var.create_web_hosting ? aws_s3_bucket.web[0].id : null
}

output "web_distribution_id" {
  description = "CloudFront distribution id (for `aws cloudfront create-invalidation` after a deploy)."
  value       = var.create_web_hosting ? aws_cloudfront_distribution.web[0].id : null
}

output "table_name" {
  value = aws_dynamodb_table.state.name
}

output "web_domain_status" {
  description = "Custom domain progress: null (not set), PENDING_VALIDATION (create web_dns_records, then apply again), ISSUED but not attached yet (apply again), or LIVE."
  value = local.web_domain == null ? null : (
    local.web_cert_arn != null ? "LIVE" : one(aws_acm_certificate.web[*].status)
  )
}

output "web_dns_records" {
  description = "DNS records to create at an external DNS host (web_domain set, route53_zone_id null): certificate validation, then the domain itself pointing at CloudFront. Empty when Route 53 manages them."
  value = local.web_domain == null || local.web_dns_managed ? [] : concat(
    [for o in flatten(aws_acm_certificate.web[*].domain_validation_options) : {
      name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value
    }],
    [{ name = "${local.web_domain}.", type = "CNAME", value = "${aws_cloudfront_distribution.web[0].domain_name}." }],
  )
}
