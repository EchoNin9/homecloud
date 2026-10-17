# --- Per-home identity -------------------------------------------------------

resource "aws_iot_thing" "home" {
  for_each = local.homes
  name     = "${var.name_prefix}-${each.key}"
}

# With a CSR: AWS signs it, the private key stays on the NAS and out of state.
# Without: AWS generates the key pair and `private_key` lands in Terraform STATE.
resource "aws_iot_certificate" "home" {
  for_each = local.homes
  active   = true
  csr      = lookup(var.device_csrs, each.key, null)
}

resource "aws_iot_policy" "home" {
  for_each = local.homes
  name     = "${var.name_prefix}-${each.key}"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Client id must equal the Thing name.
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:${local.partition}:iot:${local.region}:${local.account_id}:client/${var.name_prefix}-${each.key}"
      },
      {
        Effect = "Allow"
        Action = "iot:Publish"
        Resource = [
          "arn:${local.partition}:iot:${local.region}:${local.account_id}:topic/homecloud/${each.key}/state",
          "arn:${local.partition}:iot:${local.region}:${local.account_id}:topic/homecloud/${each.key}/cmd/ack",
          "arn:${local.partition}:iot:${local.region}:${local.account_id}:topic/homecloud/${each.key}/status",
        ]
      },
      {
        Effect   = "Allow"
        Action   = "iot:Subscribe"
        Resource = "arn:${local.partition}:iot:${local.region}:${local.account_id}:topicfilter/homecloud/${each.key}/cmd"
      },
      {
        Effect   = "Allow"
        Action   = "iot:Receive"
        Resource = "arn:${local.partition}:iot:${local.region}:${local.account_id}:topic/homecloud/${each.key}/cmd"
      },
    ]
  })
}

resource "aws_iot_policy_attachment" "home" {
  for_each = local.homes
  policy   = aws_iot_policy.home[each.key].name
  target   = aws_iot_certificate.home[each.key].arn
}

resource "aws_iot_thing_principal_attachment" "home" {
  for_each  = local.homes
  thing     = aws_iot_thing.home[each.key].name
  principal = aws_iot_certificate.home[each.key].arn
}

# --- Topic rules -> ingest Lambda ---------------------------------------------
# Same SELECT for every rule; one rule per topic (see docs/integrate.md for why this
# is not a single `FROM 'homecloud/+/#' WHERE ...` rule).
locals {
  rule_select = "SELECT *, topic(2) AS homeId, topic(3) AS kind, topic(4) AS sub, clientid() AS clientId"
  rules = {
    state  = "homecloud/+/state"
    status = "homecloud/+/status"
    ack    = "homecloud/+/cmd/ack"
  }
  rule_prefix = replace(var.name_prefix, "-", "_")
}

resource "aws_cloudwatch_log_group" "iot_errors" {
  name              = "/aws/iot/${var.name_prefix}-rule-errors"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_iam_role" "iot_rule_errors" {
  name = "${var.name_prefix}-iot-rule-errors"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "iot.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy" "iot_rule_errors" {
  name = "write-error-logs"
  role = aws_iam_role.iot_rule_errors.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.iot_errors.arn}:*"
    }]
  })
}

resource "aws_iot_topic_rule" "ingest" {
  for_each    = local.rules
  name        = "${local.rule_prefix}_ingest_${each.key}"
  enabled     = true
  sql         = "${local.rule_select} FROM '${each.value}'"
  sql_version = "2016-03-23"

  lambda {
    function_arn = aws_lambda_function.ingest.arn
  }

  error_action {
    cloudwatch_logs {
      log_group_name = aws_cloudwatch_log_group.iot_errors.name
      role_arn       = aws_iam_role.iot_rule_errors.arn
    }
  }

  tags = local.common_tags
}

resource "aws_lambda_permission" "iot_invoke_ingest" {
  for_each       = local.rules
  statement_id   = "AllowIotRule-${each.key}"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.ingest.function_name
  principal      = "iot.amazonaws.com"
  source_arn     = aws_iot_topic_rule.ingest[each.key].arn
  source_account = local.account_id
}
