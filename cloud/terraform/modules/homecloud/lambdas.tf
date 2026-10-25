# Packaging: archive_file `source` blocks assemble each zip from the lambda's own
# handler.py plus the shared hc_common.py. No build step, no pip, deterministic.
locals {
  lambdas_dir = "${path.module}/../../../lambdas"
}

data "archive_file" "ingest" {
  type        = "zip"
  output_path = "${path.module}/.build/ingest.zip"
  source {
    filename = "handler.py"
    content  = file("${local.lambdas_dir}/ingest/handler.py")
  }
  source {
    filename = "hc_common.py"
    content  = file("${local.lambdas_dir}/common/hc_common.py")
  }
}

data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    filename = "handler.py"
    content  = file("${local.lambdas_dir}/api/handler.py")
  }
  source {
    filename = "hc_common.py"
    content  = file("${local.lambdas_dir}/common/hc_common.py")
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${var.name_prefix}-ingest"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.name_prefix}-api"
  retention_in_days = 30
  tags              = local.common_tags
}

# --- ingest -------------------------------------------------------------------
resource "aws_iam_role" "ingest" {
  name               = "${var.name_prefix}-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy" "ingest" {
  name = "least-privilege"
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.state.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.ingest.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${var.name_prefix}-ingest"
  role             = aws_iam_role.ingest.arn
  runtime          = "python3.12"
  handler          = "handler.handler"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.state.name
      HOME_IDS         = join(",", var.home_ids)
      THING_PREFIX     = var.name_prefix
      HISTORY_ENTITIES = join(",", var.history_entities)
    }
  }

  depends_on = [aws_cloudwatch_log_group.ingest, aws_iam_role_policy.ingest]
  tags       = local.common_tags
}

# --- api ----------------------------------------------------------------------
resource "aws_iam_role" "api" {
  name               = "${var.name_prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy" "api" {
  name = "least-privilege"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.state.arn
      },
      {
        # cmd topics only; the API can never publish to state/status/ack.
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = [for h in var.home_ids : "arn:${local.partition}:iot:${local.region}:${local.account_id}:topic/homecloud/${h}/cmd"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.name_prefix}-api"
  role             = aws_iam_role.api.arn
  runtime          = "python3.12"
  handler          = "handler.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.state.name
      HOME_IDS         = join(",", var.home_ids)
      ALLOWED_GROUPS   = join(",", var.allowed_groups)
      ALLOWED_SERVICES = join(",", var.allowed_services)
      HISTORY_ENTITIES = join(",", var.history_entities)
      IOT_ENDPOINT     = data.aws_iot_endpoint.this.endpoint_address
      API_VERSION      = "0.1.0"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api]
  tags       = local.common_tags
}
