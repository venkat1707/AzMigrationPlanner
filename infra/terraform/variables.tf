variable "subscription_id" {
  description = "Azure subscription ID to deploy into. Leave null to use the az CLI / environment default context."
  type        = string
  default     = null
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Name of the resource group that will hold all resources."
  type        = string
}

variable "tags" {
  description = "Common tags applied to every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vnet_name" {
  description = "Name of the virtual network."
  type        = string
}

variable "vnet_address_space" {
  description = "Address space of the virtual network."
  type        = list(string)
  default     = ["10.20.0.0/16"]
}

variable "app_subnet_name" {
  description = "Name of the subnet delegated to the App Service for outbound (regional) VNet integration."
  type        = string
  default     = "snet-app-integration"
}

variable "app_subnet_address_prefix" {
  description = "Address prefix for the App Service VNet-integration subnet."
  type        = string
  default     = "10.20.1.0/24"
}

variable "pe_subnet_name" {
  description = "Name of the subnet used for the App Service's inbound private endpoint."
  type        = string
  default     = "snet-private-endpoints"
}

variable "pe_subnet_address_prefix" {
  description = "Address prefix for the private endpoint subnet."
  type        = string
  default     = "10.20.2.0/24"
}

variable "mysql_subnet_name" {
  description = "Name of the subnet delegated to the MySQL Flexible Server."
  type        = string
  default     = "snet-mysql"
}

variable "mysql_subnet_address_prefix" {
  description = "Address prefix for the MySQL Flexible Server delegated subnet."
  type        = string
  default     = "10.20.3.0/24"
}

# ---------------------------------------------------------------------------
# App Service
# ---------------------------------------------------------------------------

variable "app_service_plan_name" {
  description = "Name of the App Service Plan."
  type        = string
}

variable "app_service_plan_sku" {
  description = "SKU of the App Service Plan. Must be Premium v2/v3 (or Isolated) because inbound private endpoints require it."
  type        = string
  default     = "P1v3"

  validation {
    condition     = contains(["P1v2", "P2v2", "P3v2", "P1v3", "P2v3", "P3v3", "I1v2", "I2v2", "I3v2"], var.app_service_plan_sku)
    error_message = "app_service_plan_sku must be a Premium v2/v3 or Isolated v2 SKU (private endpoints are not supported on lower tiers)."
  }
}

variable "app_service_name" {
  description = "Globally unique name of the App Service (Linux Web App)."
  type        = string
}

variable "app_service_always_on" {
  description = "Whether the App Service should stay warm (always_on)."
  type        = bool
  default     = true
}

variable "app_service_node_version" {
  description = "Node.js runtime version for the App Service (e.g. 20-lts)."
  type        = string
  default     = "20-lts"
}

# ---------------------------------------------------------------------------
# MySQL Flexible Server
# ---------------------------------------------------------------------------

variable "mysql_server_name" {
  description = "Globally unique name of the MySQL Flexible Server."
  type        = string
}

variable "mysql_administrator_login" {
  description = "Administrator login name for the MySQL Flexible Server."
  type        = string
  default     = "mysqladmin"
}

variable "mysql_administrator_password" {
  description = "Administrator password for the MySQL Flexible Server. Provide via TF_VAR_mysql_administrator_password or a secure tfvars file - do not commit it."
  type        = string
  sensitive   = true
}

variable "mysql_sku_name" {
  description = "Compute/storage SKU of the MySQL Flexible Server (e.g. B_Standard_B1ms, GP_Standard_D2ds_v4)."
  type        = string
  default     = "GP_Standard_D2ds_v4"
}

variable "mysql_version" {
  description = "MySQL major version."
  type        = string
  default     = "8.0.21"

  validation {
    condition     = contains(["5.7", "8.0.21"], var.mysql_version)
    error_message = "mysql_version must be one of: 5.7, 8.0.21."
  }
}

variable "mysql_storage_size_gb" {
  description = "Allocated storage size, in GB, for the MySQL Flexible Server."
  type        = number
  default     = 32
}

variable "mysql_backup_retention_days" {
  description = "Backup retention period, in days, for the MySQL Flexible Server."
  type        = number
  default     = 7
}

variable "mysql_database_name" {
  description = "Name of the application database created on the MySQL Flexible Server."
  type        = string
  default     = "appdb"
}
