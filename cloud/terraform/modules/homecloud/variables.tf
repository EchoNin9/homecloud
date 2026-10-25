variable "name_prefix" {
  description = "Prefix for every resource name. IoT Things are named {name_prefix}-{homeId} (MQTT client id must equal this)."
  type        = string
  default     = "homecloud"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,30}$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumerics/hyphens, max 31 chars."
  }
}

variable "home_ids" {
  description = "Homes to provision (one IoT Thing + certificate + policy each). Each must match ^[a-z0-9-]{1,32}$."
  type        = list(string)

  validation {
    condition     = length(var.home_ids) > 0 && alltrue([for h in var.home_ids : can(regex("^[a-z0-9-]{1,32}$", h))])
    error_message = "home_ids must be non-empty and every id must match ^[a-z0-9-]{1,32}$."
  }

  validation {
    condition     = length(distinct(var.home_ids)) == length(var.home_ids)
    error_message = "home_ids must be unique."
  }
}

variable "existing_user_pool_id" {
  description = "Use an existing Cognito user pool. Null = the module creates a pool, client and hosted UI domain."
  type        = string
  default     = null
}

variable "existing_user_pool_client_ids" {
  description = "App client ids accepted by the JWT authorizer (audience). Required when existing_user_pool_id is set."
  type        = list(string)
  default     = []
}

variable "existing_cognito_domain" {
  description = "Hosted UI domain of the existing pool (host only, e.g. foo.auth.us-east-1.amazoncognito.com). Only written into config.json."
  type        = string
  default     = ""
}

variable "cognito_domain_prefix" {
  description = "Hosted UI domain prefix for the created pool. Null = \"{name_prefix}-{account_id}\". Must be globally unique per region."
  type        = string
  default     = null
}

variable "allowed_groups" {
  description = "Cognito groups (cognito:groups claim) allowed to call the API. The module creates these groups when it creates the pool."
  type        = list(string)
  default     = ["admin"]

  validation {
    condition     = length(var.allowed_groups) > 0
    error_message = "allowed_groups must not be empty."
  }
}

variable "allowed_services" {
  description = "domain.service pairs the API may publish. Default is a deliberately conservative list: no lock.unlock, no alarm, no scripts."
  type        = list(string)
  default = [
    "light.turn_on",
    "light.turn_off",
    "switch.turn_on",
    "switch.turn_off",
    "scene.turn_on",
    "climate.set_temperature",
    "cover.open_cover",
    "cover.close_cover",
    "fan.turn_on",
    "fan.turn_off",
  ]

  validation {
    condition     = alltrue([for s in var.allowed_services : can(regex("^[a-z_]+\\.[a-z_]+$", s))])
    error_message = "Each allowed service must look like domain.service (lowercase, underscores)."
  }
}

variable "create_web_hosting" {
  description = "Create a private S3 bucket + CloudFront (OAC) for the SPA, with a generated config.json."
  type        = bool
  default     = true
}

variable "web_callback_urls" {
  description = "Web app URLs. Created pool: OAuth callback + logout URLs. Always: their origins are added to API CORS. The CloudFront URL is added automatically when create_web_hosting."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for u in var.web_callback_urls : can(regex("^https?://[^/]+", u))])
    error_message = "web_callback_urls must be absolute http(s) URLs."
  }
}

variable "device_csrs" {
  description = <<-EOT
    Optional map homeId => PEM certificate signing request. When present, AWS signs the CSR and
    the device private key NEVER enters Terraform state. When absent for a home, AWS generates the
    key pair and the private key IS STORED IN TERRAFORM STATE (plaintext) - protect the state.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for h in keys(var.device_csrs) : contains(var.home_ids, h)])
    error_message = "device_csrs keys must all be in home_ids."
  }
}

variable "tags" {
  description = "Tags applied to taggable resources."
  type        = map(string)
  default     = {}
}

variable "enable_password_auth" {
  description = "Enable USER_PASSWORD_AUTH on the created Cognito client (CLI/curl testing). Off by default; apps use the hosted UI with PKCE."
  type        = bool
  default     = false
}

variable "native_redirect_uris" {
  description = "Custom-scheme redirect URIs for mobile apps (e.g. [\"homecloud://auth\"]). They are added to the created Cognito client's callback and logout URLs. If you bring your own pool, add them to your client yourself."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for u in var.native_redirect_uris : can(regex("^[a-z][a-z0-9+.-]*://", u)) && !can(regex("^https?://", u))])
    error_message = "native_redirect_uris must be custom-scheme URIs such as homecloud://auth (use web_callback_urls for http(s))."
  }
}

variable "history_entities" {
  description = "Entity id globs to keep history for (raw 35 days, daily rollups 15 months). See contract.md \"History\". Empty = no history."
  type        = list(string)
  default = [
    "sensor.*_drive_*_temperature",
    "binary_sensor.*door*",
    "light.*",
    "sun.sun",
    "sensor.docker_*",
  ]
}

variable "history_utc_offset_hours" {
  description = "Fixed UTC offset (hours) where daily history rollups split, e.g. -7 for a zone that stays at UTC-7. No DST handling."
  type        = number
  default     = 0
  validation {
    condition     = var.history_utc_offset_hours == floor(var.history_utc_offset_hours) && var.history_utc_offset_hours >= -12 && var.history_utc_offset_hours <= 14
    error_message = "history_utc_offset_hours must be a whole number from -12 to 14."
  }
}
