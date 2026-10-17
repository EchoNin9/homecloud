resource "aws_s3_bucket" "web" {
  count         = var.create_web_hosting ? 1 : 0
  bucket        = "${var.name_prefix}-web-${local.account_id}"
  force_destroy = true # content is build output, always reproducible
  tags          = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "web" {
  count                   = var.create_web_hosting ? 1 : 0
  bucket                  = aws_s3_bucket.web[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  count  = var.create_web_hosting ? 1 : 0
  bucket = aws_s3_bucket.web[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  count                             = var.create_web_hosting ? 1 : 0
  name                              = "${var.name_prefix}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web" {
  count               = var.create_web_hosting ? 1 : 0
  enabled             = true
  comment             = "${var.name_prefix} web"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.web[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id
  }

  default_cache_behavior {
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    response_headers_policy_id = "67f7725c-6f97-4210-82d7-5512b31e9d03" # Managed-SecurityHeadersPolicy
  }

  # SPA routing. With OAC and no s3:ListBucket, missing keys come back as 403, not 404.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.common_tags
}

resource "aws_s3_bucket_policy" "web" {
  count  = var.create_web_hosting ? 1 : 0
  bucket = aws_s3_bucket.web[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web[0].arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web[0].arn } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.web]
}

# Runtime config the SPA fetches at startup, so one build works for every deployment.
resource "aws_s3_object" "config" {
  count         = var.create_web_hosting ? 1 : 0
  bucket        = aws_s3_bucket.web[0].id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    apiUrl        = aws_apigatewayv2_api.this.api_endpoint
    region        = local.pool_region
    userPoolId    = local.user_pool_id
    clientId      = local.client_ids[0]
    cognitoDomain = local.cognito_domain
  })
}
