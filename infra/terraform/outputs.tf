output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "virtual_network_id" {
  value = azurerm_virtual_network.main.id
}

output "app_service_name" {
  value = azurerm_linux_web_app.main.name
}

output "app_service_default_hostname" {
  description = "The App Service's default hostname. Not publicly resolvable/reachable since public network access is disabled - resolve/access it from inside the VNet."
  value       = azurerm_linux_web_app.main.default_hostname
}

output "app_service_private_ip_address" {
  value = azurerm_private_endpoint.app_service.private_service_connection[0].private_ip_address
}

output "app_service_identity_principal_id" {
  value = azurerm_linux_web_app.main.identity[0].principal_id
}

output "mysql_server_name" {
  value = azurerm_mysql_flexible_server.main.name
}

output "mysql_server_fqdn" {
  value = azurerm_mysql_flexible_server.main.fqdn
}

output "mysql_database_name" {
  value = azurerm_mysql_flexible_database.main.name
}
