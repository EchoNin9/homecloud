# One-time bootstrap: the S3 bucket that holds OpenTofu state for every other stack.
# It starts on local state. After the first apply, follow the "migrate" step in
# docs/first-deploy.md to move this stack's own state into the bucket it created.
terraform {
  required_version = ">= 1.10" # S3 native locking (use_lockfile)
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

variable "bucket_name" {
  description = "State bucket name. Null = \"homecloud-tfstate-{account_id}-{region}\"."
  type        = string
  default     = null
}

variable "kms_key_arn" {
  description = "Optional customer-managed KMS key for SSE-KMS. Null = SSE-S3 (AES256)."
  type        = string
  default     = null
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "me" {}

locals {
  bucket = coalesce(var.bucket_name, "homecloud-tfstate-${data.aws_caller_identity.me.account_id}-${var.region}")
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.id
  policy     = data.aws_iam_policy_document.tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "bucket" {
  value = aws_s3_bucket.state.bucket
}

output "backend_hcl" {
  description = "Paste into cloud/terraform/examples/<example>/backend.hcl (set key per stack)."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.bucket}"
    key          = "homecloud/standalone.tfstate"
    region       = "${var.region}"
    encrypt      = true
    use_lockfile = true
  EOT
}
