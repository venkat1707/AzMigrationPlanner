import { closeDatabase, database } from './db.js'
import { refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { seedDatabaseServerEvidence } from './database-server-evidence.js'
import { refreshDependencyDirections } from './dependency-direction.js'
import { refreshDependencySummary } from './dependency-summary.js'

export async function migrateSchema(): Promise<void> {
  if (!(await database.schema.hasTable('app_auth_settings'))) {
    await database.schema.createTable('app_auth_settings', (table) => {
      table.integer('id').unsigned().primary()
      table.boolean('authentication_enabled').notNullable().defaultTo(false)
      table.boolean('local_enabled').notNullable().defaultTo(true)
      table.boolean('entra_enabled').notNullable().defaultTo(false)
      table.string('entra_tenant_id', 100).nullable()
      table.string('entra_client_id', 100).nullable()
      table.string('entra_redirect_uri', 500).nullable()
      table.boolean('entra_default_read').notNullable().defaultTo(true)
      table.boolean('entra_default_modify').notNullable().defaultTo(false)
      table.boolean('entra_default_delete').notNullable().defaultTo(false)
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
    await database('app_auth_settings').insert({ id: 1 })
  }

  if (!(await database.schema.hasTable('app_users'))) {
    await database.schema.createTable('app_users', (table) => {
      table.bigIncrements('id').primary()
      table.string('username', 254).notNullable().unique('uq_app_users_username')
      table.string('display_name', 200).notNullable()
      table.string('email', 254).nullable()
      table.string('password_hash', 500).nullable()
      table.string('provider', 20).notNullable().defaultTo('Local')
      table.string('entra_object_id', 100).nullable().unique('uq_app_users_entra_object_id')
      table.boolean('enabled').notNullable().defaultTo(true)
      table.boolean('is_admin').notNullable().defaultTo(false)
      table.boolean('can_read').notNullable().defaultTo(true)
      table.boolean('can_modify').notNullable().defaultTo(false)
      table.boolean('can_manage_tasks').notNullable().defaultTo(false)
      table.boolean('can_delete').notNullable().defaultTo(false)
      table.dateTime('last_login_at').nullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
      table.index(['provider', 'enabled'], 'idx_app_users_provider_enabled')
    })
  }

  if (!(await database.schema.hasColumn('app_users', 'can_manage_tasks'))) {
    await database.schema.alterTable('app_users', (table) => {
      table.boolean('can_manage_tasks').notNullable().defaultTo(false)
    })
  }

  if (!(await database.schema.hasTable('app_sessions'))) {
    await database.schema.createTable('app_sessions', (table) => {
      table.string('id', 64).primary()
      table.bigInteger('user_id').unsigned().notNullable().references('id').inTable('app_users').onDelete('CASCADE')
      table.string('csrf_token', 64).notNullable()
      table.dateTime('expires_at').notNullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.index(['user_id'], 'idx_app_sessions_user')
      table.index(['expires_at'], 'idx_app_sessions_expiry')
    })
  }

  if (!(await database.schema.hasTable('app_auth_flows'))) {
    await database.schema.createTable('app_auth_flows', (table) => {
      table.string('state', 64).primary()
      table.string('nonce', 64).notNullable()
      table.string('code_verifier', 128).nullable()
      table.dateTime('expires_at').notNullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.index(['expires_at'], 'idx_app_auth_flows_expiry')
    })
  }

  if (!(await database.schema.hasTable('import_runs'))) {
    await database.schema.createTable('import_runs', (table) => {
      table.bigIncrements('id').primary()
      table.string('file_name', 260).notNullable()
      table.string('import_type', 40).notNullable().defaultTo('Dependency')
      table.string('sheet_name', 128).nullable()
      table.string('status', 20).notNullable()
      table.bigInteger('rows_imported').notNullable().defaultTo(0)
      table.dateTime('started_at').notNullable().defaultTo(database.fn.now())
      table.dateTime('completed_at').nullable()
      table.string('error_message', 2000).nullable()
    })
  }

  if (!(await database.schema.hasColumn('import_runs', 'import_type'))) {
    await database.schema.alterTable('import_runs', (table) => {
      table.string('import_type', 40).notNullable().defaultTo('Dependency')
    })
  }
  if (!(await database.schema.hasColumn('import_runs', 'sheet_name'))) {
    await database.schema.alterTable('import_runs', (table) => {
      table.string('sheet_name', 128).nullable()
    })
  }

  if (!(await database.schema.hasTable('dependency_records'))) {
    await database.schema.createTable('dependency_records', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_run_id').unsigned().notNullable().references('id').inTable('import_runs')
      table.date('observed_date').notNullable()
      table.string('source_appliance_name', 200).nullable()
      table.string('source_machine_arm_id', 1000).nullable()
      table.string('source_server_name', 300).nullable()
      table.string('source_ip', 45).nullable()
      table.string('source_application', 500).nullable()
      table.string('source_process', 500).nullable()
      table.string('destination_machine_arm_id', 1000).nullable()
      table.string('destination_server_name', 300).nullable()
      table.string('destination_ip', 45).nullable()
      table.string('destination_application', 500).nullable()
      table.string('destination_process', 500).nullable()
      table.integer('destination_port').unsigned().nullable()
      table.bigInteger('connection_count').unsigned().notNullable()
      table.string('direction', 20).notNullable().defaultTo('Outbound')
      table.index(['import_run_id'], 'idx_dependencies_import_run')
      table.index(['source_server_name', 'destination_server_name'], 'idx_dependencies_server_pair')
      table.index(['destination_port'], 'idx_dependencies_port')
      table.index(
        ['destination_server_name', 'destination_ip', 'destination_port', 'source_server_name', 'source_ip'],
        'idx_dependencies_inbound_topology',
      )
      table.index(
        ['source_server_name', 'destination_ip', 'destination_port', 'destination_server_name'],
        'idx_dependencies_outbound_topology',
      )
    })
  }

  if (!(await database.schema.hasColumn('dependency_records', 'direction'))) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.string('direction', 20).notNullable().defaultTo('Outbound').index('idx_dependencies_direction')
    })
    await refreshDependencyDirections()
  }

  if (!(await database.schema.hasColumn('dependency_records', 'source_ip'))) {
    throw new Error('dependency_records is missing source_ip')
  }

  const dependencyIndexes = await database('information_schema.statistics')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', 'dependency_records')
    .distinct({ indexName: 'index_name' }) as Array<{ indexName: string }>
  const dependencyIndexNames = new Set(dependencyIndexes.map(({ indexName }) => indexName))
  if (!dependencyIndexNames.has('idx_dependencies_import_run')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['import_run_id'], 'idx_dependencies_import_run')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_server_pair')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['source_server_name', 'destination_server_name'], 'idx_dependencies_server_pair')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_inbound_topology')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(
        ['destination_server_name', 'destination_ip', 'destination_port', 'source_server_name', 'source_ip'],
        'idx_dependencies_inbound_topology',
      )
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_outbound_topology')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(
        ['source_server_name', 'destination_ip', 'destination_port', 'destination_server_name'],
        'idx_dependencies_outbound_topology',
      )
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_destination_process')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['destination_process'], 'idx_dependencies_destination_process')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_destination_ip')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['destination_ip'], 'idx_dependencies_destination_ip')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_server_port')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['destination_server_name', 'destination_port'], 'idx_dependencies_server_port')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_server_process')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['destination_server_name', 'destination_process'], 'idx_dependencies_server_process')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_ip_port')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['destination_ip', 'destination_port'], 'idx_dependencies_ip_port')
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_ip_process')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(['destination_ip', 'destination_process'], 'idx_dependencies_ip_process')
    })
  }

  if (!(await database.schema.hasTable('database_server_evidence'))) {
    await database.schema.createTable('database_server_evidence', (table) => {
      table.string('evidence_type', 10).notNullable()
      table.string('value', 300).notNullable()
      table.primary(['evidence_type', 'value'])
    })
    await seedDatabaseServerEvidence()
  }
  const redundantDependencyIndexes = [
    'idx_dependencies_source_server',
    'idx_dependencies_destination_server',
    'idx_dependencies_destination_ip',
    'idx_dependencies_observed_date',
    'idx_dependencies_destination_process',
    'idx_dependencies_server_port',
    'idx_dependencies_server_process',
    'idx_dependencies_ip_port',
    'idx_dependencies_ip_process',
    'idx_dependencies_direction',
  ]
  for (const indexName of redundantDependencyIndexes) {
    if (!dependencyIndexNames.has(indexName)) continue
    await database.schema.alterTable('dependency_records', (table) => {
      table.dropIndex([], indexName)
    })
  }

  if (await database.schema.hasTable('application_inventory')) {
    await database.schema.dropTable('application_inventory')
  }

  if (!(await database.schema.hasTable('server_assessments'))) {
    await database.schema.createTable('server_assessments', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_run_id').unsigned().notNullable().references('id').inTable('import_runs').onDelete('RESTRICT')
      table.string('application', 500).nullable()
      table.text('application_description').nullable()
      table.string('server_name', 300).notNullable()
      table.string('migration_readiness', 100).nullable()
      table.string('security_readiness', 100).nullable()
      table.string('os_support_status', 100).nullable()
      table.integer('support_ends_in_months').nullable()
      table.date('support_end_date').nullable()
      table.text('recommended_storage_sku').nullable()
      table.decimal('recommended_storage_size_gb', 18, 6).nullable()
      table.integer('recommended_number_of_cores').nullable()
      table.decimal('storage_utilization_percent', 18, 6).nullable()
      table.string('recommended_compute_sku', 200).nullable()
      table.decimal('total_monthly_cost_usd', 18, 6).nullable()
      table.decimal('monthly_compute_cost_usd', 18, 6).nullable()
      table.decimal('monthly_storage_cost_usd', 18, 6).nullable()
      table.decimal('monthly_security_cost_usd', 18, 6).nullable()
      table.decimal('confidence_rating_percent', 18, 6).nullable()
      table.string('operating_system_name', 500).nullable()
      table.string('os_version', 100).nullable()
      table.string('os_architecture', 50).nullable()
      table.string('boot_type', 50).nullable()
      table.integer('total_disks_count').nullable()
      table.decimal('onprem_storage_gb', 18, 6).nullable()
      table.decimal('onprem_cpu_usage_percent', 18, 6).nullable()
      table.decimal('onprem_memory_usage_percent', 18, 6).nullable()
      table.decimal('disk_read_iops', 18, 6).nullable()
      table.decimal('disk_write_iops', 18, 6).nullable()
      table.decimal('network_read_mbps', 18, 6).nullable()
      table.decimal('network_write_mbps', 18, 6).nullable()
      table.decimal('disk_read_mbps', 18, 6).nullable()
      table.decimal('disk_write_mbps', 18, 6).nullable()
      table.integer('onprem_cores_count').nullable()
      table.bigInteger('onprem_memory_mb').nullable()
      table.integer('network_adapters_count').nullable()
      table.string('source_system', 300).nullable()
      table.text('ip_address').nullable()
      table.text('mac_address').nullable()
      table.integer('total_issues_count').nullable()
      table.text('resource_tags').nullable()
      table.decimal('carbon_emissions_scope1_mtco2e', 18, 9).nullable()
      table.decimal('carbon_emissions_scope2_mtco2e', 18, 9).nullable()
      table.decimal('carbon_emissions_scope3_mtco2e', 18, 9).nullable()
      table.decimal('total_carbon_emissions_mtco2e', 18, 9).nullable()
      table.string('environment_type', 100).nullable()
      table.boolean('database_server').notNullable().defaultTo(false)
      table.index(['server_name'], 'idx_server_assessments_server')
      table.index(['migration_readiness'], 'idx_server_assessments_readiness')
      table.index(['recommended_compute_sku'], 'idx_server_assessments_compute_sku')
      table.index(['import_run_id'], 'idx_server_assessments_import_run')
      table.index(['database_server'], 'idx_server_assessments_database_server')
      table.unique(['server_name'], { indexName: 'uq_server_assessments_server_name' })
    })
  }

  if (!(await database.schema.hasColumn('server_assessments', 'database_server'))) {
    await database.schema.alterTable('server_assessments', (table) => {
      table.boolean('database_server').notNullable().defaultTo(false).index('idx_server_assessments_database_server')
    })
  }

  if (!(await database.schema.hasColumn('server_assessments', 'application_description'))) {
    await database.schema.alterTable('server_assessments', (table) => {
      table.text('application_description').nullable()
    })
  }

  if (!(await database.schema.hasTable('core_infrastructure_servers'))) {
    await database.schema.createTable('core_infrastructure_servers', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('assessment_id').unsigned().notNullable().references('id').inTable('server_assessments').onDelete('CASCADE')
      table.string('server_name', 300).notNullable()
      table.string('category', 100).notNullable()
      table.string('application', 500).nullable()
      table.string('environment_type', 100).nullable()
      table.string('operating_system_name', 500).nullable()
      table.string('os_version', 100).nullable()
      table.text('ip_address').nullable()
      table.string('migration_readiness', 100).nullable()
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
      table.unique(['assessment_id', 'category'], { indexName: 'uq_core_infrastructure_assessment_category' })
      table.index(['category', 'server_name'], 'idx_core_infrastructure_category_server')
    })
  }

  if (!(await database.schema.hasColumn('core_infrastructure_servers', 'source'))) {
    await database.schema.alterTable('core_infrastructure_servers', (table) => {
      table.string('source', 20).notNullable().defaultTo('Assessment').index('idx_core_infrastructure_source')
    })
  }
  await database.raw('ALTER TABLE core_infrastructure_servers MODIFY assessment_id BIGINT UNSIGNED NULL')
  const coreInfrastructureIndexes = await database('information_schema.statistics')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', 'core_infrastructure_servers')
    .distinct({ indexName: 'index_name' }) as Array<{ indexName: string }>
  if (!coreInfrastructureIndexes.some(({ indexName }) => indexName === 'idx_core_infrastructure_assessment')) {
    await database.schema.alterTable('core_infrastructure_servers', (table) => {
      table.index(['assessment_id'], 'idx_core_infrastructure_assessment')
    })
  }
  if (coreInfrastructureIndexes.some(({ indexName }) => indexName === 'uq_core_infrastructure_assessment_category')) {
    await database.schema.alterTable('core_infrastructure_servers', (table) => {
      table.dropUnique(['assessment_id', 'category'], 'uq_core_infrastructure_assessment_category')
    })
  }
  if (!coreInfrastructureIndexes.some(({ indexName }) => indexName === 'uq_core_infrastructure_server_category')) {
    await database.schema.alterTable('core_infrastructure_servers', (table) => {
      table.unique(['server_name', 'category'], { indexName: 'uq_core_infrastructure_server_category' })
    })
  }

  if (!(await database.schema.hasTable('core_infrastructure_networks'))) {
    await database.schema.createTable('core_infrastructure_networks', (table) => {
      table.string('network_type', 30).notNullable()
      table.string('ip_range', 100).notNullable()
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
      table.primary(['network_type', 'ip_range'])
    })
  } else {
    const networkPrimaryKey = await database('information_schema.statistics')
      .whereRaw('table_schema = DATABASE()')
      .where({ table_name: 'core_infrastructure_networks', index_name: 'PRIMARY' })
      .orderBy('seq_in_index')
      .pluck('column_name') as string[]
    if (networkPrimaryKey.join(',') !== 'network_type,ip_range') {
      await database.raw('ALTER TABLE core_infrastructure_networks DROP PRIMARY KEY, ADD PRIMARY KEY (network_type, ip_range)')
    }
  }
  if (!(await database.schema.hasTable('core_infrastructure_load_balancer_ips'))) {
    await database.schema.createTable('core_infrastructure_load_balancer_ips', (table) => {
      table.string('ip_address', 45).primary()
      table.string('source', 20).notNullable().defaultTo('Manual')
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
  }
  const coreInfrastructureCount = await database('core_infrastructure_servers').count({ count: 'id' }).first()
  if (Number(coreInfrastructureCount?.count ?? 0) === 0) await refreshCoreInfrastructureSummary()

  const assessmentImportForeignKey = await database('information_schema.referential_constraints')
    .select({ constraintName: 'constraint_name', deleteRule: 'delete_rule' })
    .whereRaw('constraint_schema = DATABASE()')
    .where({ table_name: 'server_assessments', referenced_table_name: 'import_runs' })
    .first() as { constraintName: string; deleteRule: string } | undefined
  if (assessmentImportForeignKey?.deleteRule === 'CASCADE') {
    await database.schema.alterTable('server_assessments', (table) => {
      table.dropForeign(['import_run_id'], assessmentImportForeignKey.constraintName)
      table.foreign('import_run_id').references('id').inTable('import_runs').onDelete('RESTRICT')
    })
  }

  const assessmentIndexes = await database('information_schema.statistics')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', 'server_assessments')
    .distinct({ indexName: 'index_name' }) as Array<{ indexName: string }>
  if (!assessmentIndexes.some(({ indexName }) => indexName === 'uq_server_assessments_server_name')) {
    await database.raw(`
      DELETE older
      FROM server_assessments AS older
      INNER JOIN server_assessments AS newer
        ON older.server_name = newer.server_name
       AND older.id < newer.id
    `)
    await database.schema.alterTable('server_assessments', (table) => {
      table.unique(['server_name'], { indexName: 'uq_server_assessments_server_name' })
    })
  }

  if (!(await database.schema.hasTable('dependency_summary'))) {
    await database.schema.createTable('dependency_summary', (table) => {
      table.integer('id').unsigned().primary()
      table.bigInteger('total_dependencies').unsigned().notNullable().defaultTo(0)
      table.bigInteger('total_connections').unsigned().notNullable().defaultTo(0)
      table.integer('source_servers').unsigned().notNullable().defaultTo(0)
      table.integer('destination_servers').unsigned().notNullable().defaultTo(0)
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
  }

  if (!(await database.schema.hasTable('dependency_source_servers'))) {
    await database.schema.createTable('dependency_source_servers', (table) => {
      table.string('server_name', 300).primary()
    })
    await database('dependency_source_servers').insert(
      database('dependency_records').distinct({ server_name: 'source_server_name' }).whereNotNull('source_server_name'),
    )
  }
  if (!(await database.schema.hasTable('dependency_destination_servers'))) {
    await database.schema.createTable('dependency_destination_servers', (table) => {
      table.string('server_name', 300).primary()
    })
    await database('dependency_destination_servers').insert(
      database('dependency_records').distinct({ server_name: 'destination_server_name' }).whereNotNull('destination_server_name'),
    )
  }

  if (!(await database('dependency_summary').where({ id: 1 }).first())) {
    await refreshDependencySummary()
  }

  if (!(await database.schema.hasTable('migration_wave_plans'))) {
    await database.schema.createTable('migration_wave_plans', (table) => {
      table.integer('id').unsigned().primary()
      table.json('plan_json').notNullable()
      table.dateTime('generated_at').notNullable()
      table.dateTime('saved_at').notNullable().defaultTo(database.fn.now())
    })
  }

  if (!(await database.schema.hasTable('task_comment_audit'))) {
    await database.schema.createTable('task_comment_audit', (table) => {
      table.bigIncrements('id').primary()
      table.string('task_key', 1000).notNullable()
      table.string('task_type', 20).notNullable()
      table.text('comment').notNullable()
      table.bigInteger('actor_user_id').unsigned().nullable().references('id').inTable('app_users').onDelete('SET NULL')
      table.string('actor_display_name', 200).notNullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.index(['task_key', 'created_at'], 'idx_task_comment_audit_task')
    })
  }

  if (!(await database.schema.hasTable('windows_services_ports'))) {
    await database.schema.createTable('windows_services_ports', (table) => {
      table.bigIncrements('id').primary()
      table.string('windows_service', 100).notNullable()
      table.string('short_description', 500).notNullable()
      table.string('ports', 200).notNullable()
      table.string('network_protocol', 50).notNullable()
      table.string('application_protocol', 200).notNullable()
      table.index(['windows_service'], 'idx_windows_services_ports_service')
      table.index(['ports'], 'idx_windows_services_ports_ports')
    })
  }

}

migrateSchema()
  .then(() => console.log('MySQL schema is ready.'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(closeDatabase)