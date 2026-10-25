# Daily history rollups (contract.md "History"). Same packaging as lambdas.tf.
data "archive_file" "rollup" {
  type        = "zip"
  output_path = "${path.module}/.build/rollup.zip"
  source {
    filename = "handler.py"
    content  = file("${local.lambdas_dir}/rollup/handler.py")
  }
  source {
    filename = "hc_common.py"
    content  = file("${local.lambdas_dir}/common/hc_common.py")
  }
}

resource "aws_cloudwatch_log_group" "rollup" {
  name              = "/aws/lambda/${var.name_prefix}-rollup"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_iam_role" "rollup" {
  name               = "${var.name_prefix}-rollup"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy" "rollup" {
  name = "least-privilege"
  role = aws_iam_role.rollup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.state.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.rollup.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "rollup" {
  function_name    = "${var.name_prefix}-rollup"
  role             = aws_iam_role.rollup.arn
  runtime          = "python3.12"
  handler          = "handler.handler"
  filename         = data.archive_file.rollup.output_path
  source_code_hash = data.archive_file.rollup.output_base64sha256
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.state.name
      HOME_IDS         = join(",", var.home_ids)
      HISTORY_ENTITIES = join(",", var.history_entities)
    }
  }

  depends_on = [aws_cloudwatch_log_group.rollup, aws_iam_role_policy.rollup]
  tags       = local.common_tags
}

resource "aws_cloudwatch_event_rule" "rollup" {
  name                = "${var.name_prefix}-rollup"
  schedule_expression = "cron(15 0 * * ? *)" # 00:15 UTC daily
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "rollup" {
  rule = aws_cloudwatch_event_rule.rollup.name
  arn  = aws_lambda_function.rollup.arn
}

resource "aws_lambda_permission" "rollup" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rollup.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.rollup.arn
}
