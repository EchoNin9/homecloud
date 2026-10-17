# Only created when existing_user_pool_id is null.
resource "aws_cognito_user_pool" "this" {
  count                    = local.create_pool ? 1 : 0
  name                     = "${var.name_prefix}-users"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true # private install: no self sign-up
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = local.common_tags
}

resource "aws_cognito_user_group" "allowed" {
  for_each     = local.create_pool ? toset(var.allowed_groups) : toset([])
  name         = each.key
  user_pool_id = aws_cognito_user_pool.this[0].id
}

resource "aws_cognito_user_pool_domain" "this" {
  count        = local.create_pool ? 1 : 0
  domain       = coalesce(var.cognito_domain_prefix, "${var.name_prefix}-${local.account_id}")
  user_pool_id = aws_cognito_user_pool.this[0].id
}

resource "aws_cognito_user_pool_client" "this" {
  count           = local.create_pool ? 1 : 0
  name            = "${var.name_prefix}-web"
  user_pool_id    = aws_cognito_user_pool.this[0].id
  generate_secret = false

  # USER_PASSWORD_AUTH is opt-in (handy for CLI testing); apps should use the hosted UI / SRP.
  explicit_auth_flows = concat(
    ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    var.enable_password_auth ? ["ALLOW_USER_PASSWORD_AUTH"] : []
  )

  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = local.auth_redirect_urls
  logout_urls                          = local.auth_redirect_urls

  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 1
  id_token_validity             = 1
  refresh_token_validity        = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
