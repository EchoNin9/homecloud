# Optional: IAM role GitHub Actions assumes (OIDC) to deploy on push to the deploy branch.
# Off unless github_repo is set. Uses the account's existing GitHub OIDC provider.

variable "github_repo" {
  description = "\"owner/repo\" allowed to deploy. Null = no deploy role."
  type        = string
  default     = null
}

variable "github_sub_prefix" {
  description = "OIDC 'sub' prefix if the repo uses immutable subjects (repo:owner@id/name@id). Null = \"repo:{github_repo}\". Check with: gh api repos/OWNER/REPO/actions/oidc/customization/sub"
  type        = string
  default     = null
}

variable "deploy_branch" {
  type    = string
  default = "main"
}

variable "deploy_prefix" {
  description = "The module's name_prefix. The role may only manage IAM/S3/DynamoDB resources starting with it."
  type        = string
  default     = "homecloud"
}

locals {
  deploy = var.github_repo == null ? 0 : 1
  acct   = data.aws_caller_identity.me.account_id
}

data "aws_iam_openid_connect_provider" "github" {
  count = local.deploy
  url   = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "deploy_trust" {
  count = local.deploy
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${coalesce(var.github_sub_prefix, "repo:${var.github_repo}")}:ref:refs/heads/${var.deploy_branch}"]
    }
  }
}

# ponytail: services without useful resource-level scoping (API GW, IoT, Cognito, CloudFront,
# Lambda, Logs, ACM, EventBridge) get "*"; IAM, S3 and DynamoDB are pinned to the prefix.
data "aws_iam_policy_document" "deploy" {
  count = local.deploy
  statement {
    sid       = "StateBucket"
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
  }
  statement {
    sid       = "PrefixedBuckets"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::${var.deploy_prefix}-*", "arn:aws:s3:::${var.deploy_prefix}-*/*"]
  }
  statement {
    sid       = "PrefixedTables"
    actions   = ["dynamodb:*"]
    resources = ["arn:aws:dynamodb:*:${local.acct}:table/${var.deploy_prefix}-*"]
  }
  statement {
    sid       = "PrefixedRoles"
    actions   = ["iam:*"]
    resources = ["arn:aws:iam::${local.acct}:role/${var.deploy_prefix}-*", "arn:aws:iam::${local.acct}:policy/${var.deploy_prefix}-*"]
  }
  statement {
    sid       = "Services"
    actions   = ["apigateway:*", "iot:*", "cognito-idp:*", "cloudfront:*", "lambda:*", "logs:*", "acm:*", "events:*", "iam:Get*", "iam:List*"]
    resources = ["*"]
  }
  statement {
    # Only used when the stack's web_domain is hosted in Route 53 (route53_zone_id set).
    sid       = "Route53Records"
    actions   = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:ListTagsForResource"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "deploy" {
  count              = local.deploy
  name               = "github-actions-${var.deploy_prefix}-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust[0].json
}

resource "aws_iam_role_policy" "deploy" {
  count  = local.deploy
  name   = "deploy"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy[0].json
}

output "deploy_role_arn" {
  value = one(aws_iam_role.deploy[*].arn)
}
