# VNet-integrated (private access) MySQL Flexible Server: no public endpoint is
# provisioned at all when delegated_subnet_id + private_dns_zone_id are set.
resource "azurerm_mysql_flexible_server" "main" {
  name                = var.mysql_server_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  administrator_login    = var.mysql_administrator_login
  administrator_password = var.mysql_administrator_password

  sku_name = var.mysql_sku_name
  version  = var.mysql_version

  storage {
    size_gb           = var.mysql_storage_size_gb
    auto_grow_enabled = true
  }

  backup_retention_days        = var.mysql_backup_retention_days
  geo_redundant_backup_enabled = false

  delegated_subnet_id = azurerm_subnet.mysql.id
  private_dns_zone_id = azurerm_private_dns_zone.mysql.id

  tags = var.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.mysql]
}

resource "azurerm_mysql_flexible_database" "main" {
  name                = var.mysql_database_name
  resource_group_name = azurerm_resource_group.main.name
  server_name         = azurerm_mysql_flexible_server.main.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}

# Defense in depth: require TLS for all client connections.
resource "azurerm_mysql_flexible_server_configuration" "require_secure_transport" {
  name                = "require_secure_transport"
  resource_group_name = azurerm_resource_group.main.name
  server_name         = azurerm_mysql_flexible_server.main.name
  value               = "ON"
}
