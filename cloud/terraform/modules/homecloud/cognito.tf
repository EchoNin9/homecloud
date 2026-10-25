# Only created when existing_user_pool_id is null.
resource "aws_cognito_user_pool" "this" {
  count               = local.create_pool ? 1 : 0
  name                = "${var.name_prefix}-users"
  username_attributes = ["email"]
  # Managed login branding needs Essentials (free for the first 10,000 MAU; the default for new pools).
  user_pool_tier           = var.cognito_branding ? "ESSENTIALS" : null
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
  # 2 = managed login (styleable, below); 1 = the classic hosted UI.
  managed_login_version = var.cognito_branding ? 2 : 1
  # Switch to managed login only after the style exists: a v2 domain with no style can't show a sign-in page.
  depends_on = [aws_cognito_managed_login_branding.this]
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

# Sign-in page styled like the dashboard: HomeCloud logo, teal accent, follows the browser's light/dark mode.
# Colours are RRGGBBAA hex without '#'. Values Cognito doesn't know are ignored, so keep to its schema.
resource "aws_cognito_managed_login_branding" "this" {
  count        = local.create_pool && var.cognito_branding ? 1 : 0
  client_id    = aws_cognito_user_pool_client.this[0].id
  user_pool_id = aws_cognito_user_pool.this[0].id

  asset {
    bytes      = filebase64("${path.module}/branding/logo-light.svg")
    category   = "FORM_LOGO"
    color_mode = "LIGHT"
    extension  = "SVG"
  }
  asset {
    bytes      = filebase64("${path.module}/branding/logo-dark.svg")
    category   = "FORM_LOGO"
    color_mode = "DARK"
    extension  = "SVG"
  }
  asset {
    bytes      = filebase64("${path.module}/branding/favicon.svg")
    category   = "FAVICON_SVG"
    color_mode = "LIGHT"
    extension  = "SVG"
  }

  settings = jsonencode({
    categories = {
      global = { colorSchemeMode = "AUTO", spacingDensity = "REGULAR" }
      form   = { location = { horizontal = "CENTER", vertical = "CENTER" } }
    }
    components = {
      favicon        = { enabledTypes = ["SVG"] }
      pageBackground = { image = { enabled = false }, lightMode = { color = "f2f3f5ff" }, darkMode = { color = "0c0f13ff" } }
      form = {
        borderRadius = 14
        logo         = { enabled = true, formInclusion = "IN", location = "CENTER", position = "TOP" }
        lightMode    = { backgroundColor = "ffffffff", borderColor = "e1e4e9ff" }
        darkMode     = { backgroundColor = "161a20ff", borderColor = "242a33ff" }
      }
      primaryButton = {
        lightMode = {
          defaults = { backgroundColor = "0c7385ff", textColor = "ffffffff" }
          hover    = { backgroundColor = "0a6271ff", textColor = "ffffffff" }
          active   = { backgroundColor = "08515dff", textColor = "ffffffff" }
        }
        darkMode = {
          defaults = { backgroundColor = "4fc4d3ff", textColor = "04191dff" }
          hover    = { backgroundColor = "72d2deff", textColor = "04191dff" }
          active   = { backgroundColor = "3aa9b8ff", textColor = "04191dff" }
        }
      }
    }
  })
}
