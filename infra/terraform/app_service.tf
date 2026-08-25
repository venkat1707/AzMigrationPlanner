resource "azurerm_service_plan" "main" {
  name                = var.app_service_plan_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = var.app_service_plan_sku
  tags                = var.tags
}

resource "azurerm_linux_web_app" "main" {
  name                = var.app_service_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.main.id

  https_only                    = true
  public_network_access_enabled = false
  virtual_network_subnet_id     = azurerm_subnet.app.id

  site_config {
    always_on              = var.app_service_always_on
    vnet_route_all_enabled = true # force ALL outbound traffic through the VNet, where the NSG blocks Internet destinations
    ftps_state             = "Disabled"
    minimum_tls_version    = "1.2"

    application_stack {
      node_version = var.app_service_node_version
    }
  }

  # NOTE: for production, replace the plaintext DB credentials below with Key
  # Vault references (@Microsoft.KeyVault(...)) resolved via a managed identity.
  app_settings = {
    "WEBSITE_DNS_SERVER" = "168.63.129.16"
    "MYSQL_HOST"         = azurerm_mysql_flexible_server.main.fqdn
    "MYSQL_DATABASE"     = azurerm_mysql_flexible_database.main.name
    "MYSQL_USER"         = var.mysql_administrator_login
    "MYSQL_PASSWORD"     = var.mysql_administrator_password
  }

  identity {
    type = "SystemAssigned"
  }

  tags = var.tags
}

# Inbound private endpoint: this is what removes the App Service's public
# default-hostname endpoint from being reachable and gives it a private IP.
resource "azurerm_private_endpoint" "app_service" {
  name                = "${var.app_service_name}-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = var.tags

  private_service_connection {
    name                           = "${var.app_service_name}-psc"
    private_connection_resource_id = azurerm_linux_web_app.main.id
    subresource_names              = ["sites"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "app-service-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.app_service.id]
  }
}
