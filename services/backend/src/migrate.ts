import { pathToFileURL } from 'node:url'
import { closeDatabase, database } from './db.js'
import { refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { seedDatabaseServerEvidence } from './database-server-evidence.js'
import { refreshDependencyDirections } from './dependency-direction.js'
import { refreshDependencySummary } from './dependency-summary.js'

export const requiredDependencyIndexNames = [
  'idx_dependencies_import_run',
  'idx_dependencies_server_pair',
  'idx_dependencies_port',
  'idx_dependencies_inbound_map',
  'idx_dependencies_outbound_map',
  'idx_dependencies_inbound_fw',
  'idx_dependencies_outbound_fw',
] as const

export const redundantDependencyIndexNames = [
  'idx_dependencies_source_server',
  'idx_dependencies_destination_server',
  'idx_dependencies_inbound_topology',
  'idx_dependencies_outbound_topology',
  'idx_dependencies_destination_ip',
  'idx_dependencies_observed_date',
  'idx_dependencies_destination_process',
  'idx_dependencies_server_port',
  'idx_dependencies_server_process',
  'idx_dependencies_ip_port',
  'idx_dependencies_ip_process',
  'idx_dependencies_direction',
] as const

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
        ['destination_server_name', 'source_server_name', 'destination_port'],
        'idx_dependencies_inbound_map',
      )
      table.index(
        ['source_server_name', 'destination_server_name', 'destination_port'],
        'idx_dependencies_outbound_map',
      )
      table.index(
        ['destination_server_name', 'destination_ip', 'destination_port', 'source_server_name', 'source_ip', 'connection_count'],
        'idx_dependencies_inbound_fw',
      )
      table.index(
        ['source_server_name', 'destination_ip', 'destination_port', 'destination_server_name', 'connection_count'],
        'idx_dependencies_outbound_fw',
      )
    })
  }

  if (!(await database.schema.hasColumn('dependency_records', 'direction'))) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.string('direction', 20).notNullable().defaultTo('Outbound').index('idx_dependencies_direction')
    })
    await refreshDependencyDirections()
  }

  if (!(await database.schema.hasColumn('dependency_records', 'protocol'))) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.string('protocol', 10).nullable()
    })
  }

  if (!(await database.schema.hasColumn('dependency_records', 'source_ip'))) {
    throw new Error('dependency_records is missing source_ip')
  }

  if (!(await database.schema.hasTable('dns_records'))) {
    await database.schema.createTable('dns_records', (table) => {
      table.bigIncrements('id').primary()
      table.string('query', 300).notNullable()
      table.string('ip_address', 64).notNullable()
      table.date('observed_date').nullable()
      table.string('source', 30).notNullable().defaultTo('Corelight')
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
      table.unique(['query', 'ip_address'], 'uq_dns_records_query_ip')
      table.index(['ip_address'], 'idx_dns_records_ip')
    })
  }

  // Vendor exports (F5, Citrix ADC, AWS ELB, Azure LB, NGINX, HAProxy, Kemp, ...) differ in schema, so the
  // original JSON/XML/CSV document is kept verbatim in raw_content rather than normalized into columns.
  if (!(await database.schema.hasTable('load_balancer_rule_imports'))) {
    await database.schema.createTable('load_balancer_rule_imports', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_run_id').unsigned().notNullable().references('id').inTable('import_runs').onDelete('CASCADE')
      table.string('vendor', 100).nullable()
      table.string('file_name', 260).notNullable()
      table.string('format', 10).notNullable()
      table.text('raw_content', 'longtext').notNullable()
      table.string('content_hash', 64).notNullable()
      table.integer('size_bytes').unsigned().notNullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.index(['content_hash'], 'idx_load_balancer_rule_imports_hash')
    })
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
  if (!dependencyIndexNames.has('idx_dependencies_inbound_map')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(
        ['destination_server_name', 'source_server_name', 'destination_port'],
        'idx_dependencies_inbound_map',
      )
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_outbound_map')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(
        ['source_server_name', 'destination_server_name', 'destination_port'],
        'idx_dependencies_outbound_map',
      )
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_inbound_fw')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(
        ['destination_server_name', 'destination_ip', 'destination_port', 'source_server_name', 'source_ip', 'connection_count'],
        'idx_dependencies_inbound_fw',
      )
    })
  }
  if (!dependencyIndexNames.has('idx_dependencies_outbound_fw')) {
    await database.schema.alterTable('dependency_records', (table) => {
      table.index(
        ['source_server_name', 'destination_ip', 'destination_port', 'destination_server_name', 'connection_count'],
        'idx_dependencies_outbound_fw',
      )
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
  const existingRedundantIndexes = redundantDependencyIndexNames.filter((indexName) => dependencyIndexNames.has(indexName))
  if (existingRedundantIndexes.length > 0) {
    const clauses = existingRedundantIndexes.map(() => 'DROP INDEX ??').join(', ')
    await database.raw(`ALTER TABLE dependency_records ${clauses}`, existingRedundantIndexes)
  }

  if (await database.schema.hasTable('application_inventory')) {
    await database.schema.dropTable('application_inventory')
  }

  if (!(await database.schema.hasTable('applications'))) {
    await database.schema.createTable('applications', (table) => {
      table.string('name', 500).primary()
      table.text('description').nullable()
      table.string('first_name', 100).nullable()
      table.string('last_name', 100).nullable()
      table.string('email_address', 254).nullable()
      table.string('treatment_plan', 20).nullable()
      table.string('source', 30).notNullable().defaultTo('Derived')
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
  }

  if (!(await database.schema.hasColumn('applications', 'treatment_plan'))) {
    await database.schema.alterTable('applications', (table) => {
      table.string('treatment_plan', 20).nullable()
    })
  }
  if (!(await database.schema.hasColumn('applications', 'first_name'))) {
    await database.schema.alterTable('applications', (table) => {
      table.string('first_name', 100).nullable()
    })
  }
  if (!(await database.schema.hasColumn('applications', 'last_name'))) {
    await database.schema.alterTable('applications', (table) => {
      table.string('last_name', 100).nullable()
    })
  }
  if (!(await database.schema.hasColumn('applications', 'email_address'))) {
    await database.schema.alterTable('applications', (table) => {
      table.string('email_address', 254).nullable()
    })
  }

  if (!(await database.schema.hasTable('server_assessments'))) {
    await database.schema.createTable('server_assessments', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_run_id').unsigned().notNullable().references('id').inTable('import_runs').onDelete('RESTRICT')
      table.string('application', 500).nullable().references('name').inTable('applications').onUpdate('CASCADE').onDelete('RESTRICT')
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

  if (!(await database.schema.hasTable('environment_identification_rules'))) {
    await database.schema.createTable('environment_identification_rules', (table) => {
      table.bigIncrements('id').primary()
      table.string('environment', 100).notNullable()
      table.text('name_patterns').nullable()
      table.text('ip_ranges').nullable()
      table.string('rule_field', 50).nullable()
      table.string('rule_operator', 30).nullable()
      table.text('rule_value').nullable()
      table.integer('priority').unsigned().notNullable().defaultTo(100)
      table.integer('sort_order').unsigned().notNullable()
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
      table.index(['sort_order'], 'idx_environment_rules_sort_order')
    })
  }
  if (!(await database.schema.hasColumn('environment_identification_rules', 'rule_field'))) {
    await database.schema.alterTable('environment_identification_rules', (table) => {
      table.string('rule_field', 50).nullable()
      table.string('rule_operator', 30).nullable()
      table.text('rule_value').nullable()
      table.integer('priority').unsigned().notNullable().defaultTo(100)
    })
  }

  const assessmentApplicationColumn = await database('information_schema.columns')
    .select({ isNullable: 'is_nullable' })
    .whereRaw('table_schema = DATABASE()')
    .where({ table_name: 'server_assessments', column_name: 'application' })
    .first() as { isNullable: string } | undefined
  if (assessmentApplicationColumn?.isNullable !== 'YES') {
    await database.schema.alterTable('server_assessments', (table) => {
      table.string('application', 500).nullable().alter()
    })
  }

  await database.raw(`
    INSERT INTO applications (name, description, source)
    SELECT application, MAX(application_description), 'Legacy'
    FROM server_assessments
    WHERE application IS NOT NULL AND TRIM(application) <> ''
    GROUP BY application
    ON DUPLICATE KEY UPDATE description = COALESCE(applications.description, VALUES(description))
  `)
  const assessmentApplicationForeignKey = await database('information_schema.referential_constraints')
    .select({ constraintName: 'constraint_name' })
    .whereRaw('constraint_schema = DATABASE()')
    .where({ table_name: 'server_assessments', referenced_table_name: 'applications' })
    .first() as { constraintName: string } | undefined
  if (!assessmentApplicationForeignKey) {
    await database.schema.alterTable('server_assessments', (table) => {
      table.foreign('application', 'fk_server_assessments_application')
        .references('name').inTable('applications').onUpdate('CASCADE').onDelete('RESTRICT')
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

  if (!(await database.schema.hasTable('migration_wave_plan_filters'))) {
    await database.schema.createTable('migration_wave_plan_filters', (table) => {
      table.integer('id').unsigned().primary()
      table.json('filter_json').notNullable()
      table.json('considered_servers_json').notNullable()
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

  if (!(await database.schema.hasTable('agent_endpoints'))) {
    await database.schema.createTable('agent_endpoints', (table) => {
      table.bigIncrements('id').primary()
      table.string('name', 200).notNullable().unique()
      table.string('purpose', 40).notNullable().defaultTo('general')
      table.string('endpoint_url', 1000).notNullable()
      table.string('auth_scope', 400).nullable()
      table.string('description', 500).nullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
  }

  // Normalized, agent-parsed load balancer rulesets — the single source of truth for rule analysis,
  // kept separate from load_balancer_rule_imports (which only stores the raw document). Re-parsing an
  // import adds a new version rather than overwriting, so prior analysis stays reproducible.
  if (!(await database.schema.hasTable('load_balancer_rulesets'))) {
    await database.schema.createTable('load_balancer_rulesets', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_id').unsigned().notNullable().references('id').inTable('load_balancer_rule_imports').onDelete('CASCADE')
      table.integer('version').unsigned().notNullable()
      table.string('vendor', 100).nullable()
      table.string('status', 20).notNullable()
      table.bigInteger('agent_endpoint_id').unsigned().nullable().references('id').inTable('agent_endpoints').onDelete('SET NULL')
      table.integer('virtual_server_count').unsigned().notNullable().defaultTo(0)
      table.integer('pool_count').unsigned().notNullable().defaultTo(0)
      table.integer('rule_count').unsigned().notNullable().defaultTo(0)
      table.json('warnings').nullable()
      table.text('error_message').nullable()
      // Full agent reply kept verbatim as a fidelity fallback in case the relational mapping below misses a field.
      table.json('agent_response_json').nullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.unique(['import_id', 'version'], 'uq_load_balancer_rulesets_version')
      table.index(['import_id'], 'idx_load_balancer_rulesets_import')
    })
  }

  if (!(await database.schema.hasTable('lb_ruleset_pools'))) {
    await database.schema.createTable('lb_ruleset_pools', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('load_balancer_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.string('load_balancing_method', 100).nullable()
      table.json('monitor_external_ids').nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_lb_ruleset_pools_ruleset')
    })
  }

  if (!(await database.schema.hasTable('lb_ruleset_pool_members'))) {
    await database.schema.createTable('lb_ruleset_pool_members', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('pool_id').unsigned().notNullable().references('id').inTable('lb_ruleset_pools').onDelete('CASCADE')
      table.string('ip_address', 64).nullable()
      table.integer('port').unsigned().nullable()
      table.integer('weight').unsigned().nullable()
      table.integer('priority_group').unsigned().nullable()
      table.string('state', 30).nullable()
      table.json('extra_attributes').nullable()
      table.index(['pool_id'], 'idx_lb_ruleset_pool_members_pool')
    })
  }

  if (!(await database.schema.hasTable('lb_ruleset_monitors'))) {
    await database.schema.createTable('lb_ruleset_monitors', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('load_balancer_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.string('type', 50).nullable()
      table.integer('interval_seconds').unsigned().nullable()
      table.integer('timeout_seconds').unsigned().nullable()
      table.text('send_string').nullable()
      table.text('receive_string').nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_lb_ruleset_monitors_ruleset')
    })
  }

  if (!(await database.schema.hasTable('lb_ruleset_virtual_servers'))) {
    await database.schema.createTable('lb_ruleset_virtual_servers', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('load_balancer_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.string('ip_address', 64).nullable()
      table.integer('port').unsigned().nullable()
      table.string('protocol', 30).nullable()
      table.bigInteger('pool_id').unsigned().nullable().references('id').inTable('lb_ruleset_pools').onDelete('SET NULL')
      table.string('ssl_profile', 200).nullable()
      table.string('persistence', 100).nullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_lb_ruleset_virtual_servers_ruleset')
    })
  }

  if (!(await database.schema.hasTable('lb_ruleset_rules'))) {
    await database.schema.createTable('lb_ruleset_rules', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('load_balancer_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.bigInteger('virtual_server_id').unsigned().nullable().references('id').inTable('lb_ruleset_virtual_servers').onDelete('SET NULL')
      table.integer('priority').nullable()
      table.text('description').nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_lb_ruleset_rules_ruleset')
    })
  }

  // Adjacency list so arbitrarily nested AND/OR/NOT condition trees (F5 iRule logic, NetScaler
  // compound expressions, Zscaler policy criteria) can be stored and rebuilt without a fixed depth limit.
  if (!(await database.schema.hasTable('lb_ruleset_rule_conditions'))) {
    await database.schema.createTable('lb_ruleset_rule_conditions', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('rule_id').unsigned().notNullable().references('id').inTable('lb_ruleset_rules').onDelete('CASCADE')
      table.bigInteger('parent_condition_id').unsigned().nullable().references('id').inTable('lb_ruleset_rule_conditions').onDelete('CASCADE')
      table.string('operator', 10).notNullable()
      table.string('field', 300).nullable()
      table.string('comparator', 30).nullable()
      table.json('value').nullable()
      table.boolean('negate').notNullable().defaultTo(false)
      table.integer('sort_order').unsigned().notNullable().defaultTo(0)
      table.index(['rule_id'], 'idx_lb_ruleset_rule_conditions_rule')
      table.index(['parent_condition_id'], 'idx_lb_ruleset_rule_conditions_parent')
    })
  }

  if (!(await database.schema.hasTable('lb_ruleset_rule_actions'))) {
    await database.schema.createTable('lb_ruleset_rule_actions', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('rule_id').unsigned().notNullable().references('id').inTable('lb_ruleset_rules').onDelete('CASCADE')
      table.integer('sort_order').unsigned().notNullable().defaultTo(0)
      table.string('action_type', 100).notNullable()
      table.string('target', 300).nullable()
      table.json('parameters').nullable()
      table.json('extra_attributes').nullable()
      table.index(['rule_id'], 'idx_lb_ruleset_rule_actions_rule')
    })
  }

  // Vendor exports (Palo Alto, Fortigate, Cisco ASA/IOS/Firepower, AWS Security Groups/NACLs, Check Point, ...)
  // differ in schema, so the original JSON/XML/CSV/Conf document is kept verbatim in raw_content rather than
  // normalized into columns. Mirrors load_balancer_rule_imports.
  if (!(await database.schema.hasTable('firewall_rule_imports'))) {
    await database.schema.createTable('firewall_rule_imports', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_run_id').unsigned().notNullable().references('id').inTable('import_runs').onDelete('CASCADE')
      table.string('vendor', 100).nullable()
      table.string('file_name', 260).notNullable()
      table.string('format', 10).notNullable()
      table.text('raw_content', 'longtext').notNullable()
      table.string('content_hash', 64).notNullable()
      table.integer('size_bytes').unsigned().notNullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.index(['content_hash'], 'idx_firewall_rule_imports_hash')
    })
  }

  // Normalized, agent-parsed firewall rulesets — mirrors load_balancer_rulesets. Re-parsing an import
  // adds a new version rather than overwriting, so prior analysis stays reproducible.
  if (!(await database.schema.hasTable('firewall_rulesets'))) {
    await database.schema.createTable('firewall_rulesets', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('import_id').unsigned().notNullable().references('id').inTable('firewall_rule_imports').onDelete('CASCADE')
      table.integer('version').unsigned().notNullable()
      table.string('vendor', 100).nullable()
      table.string('status', 20).notNullable()
      table.bigInteger('agent_endpoint_id').unsigned().nullable().references('id').inTable('agent_endpoints').onDelete('SET NULL')
      table.integer('zone_count').unsigned().notNullable().defaultTo(0)
      table.integer('address_object_count').unsigned().notNullable().defaultTo(0)
      table.integer('service_object_count').unsigned().notNullable().defaultTo(0)
      table.integer('rule_count').unsigned().notNullable().defaultTo(0)
      table.integer('nat_rule_count').unsigned().notNullable().defaultTo(0)
      table.json('warnings').nullable()
      table.text('error_message').nullable()
      // Full agent reply kept verbatim as a fidelity fallback in case the relational mapping below misses a field.
      table.json('agent_response_json').nullable()
      table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
      table.unique(['import_id', 'version'], 'uq_firewall_rulesets_version')
      table.index(['import_id'], 'idx_firewall_rulesets_import')
    })
  }

  if (!(await database.schema.hasTable('firewall_ruleset_zones'))) {
    await database.schema.createTable('firewall_ruleset_zones', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('firewall_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_firewall_ruleset_zones_ruleset')
    })
  }

  if (!(await database.schema.hasTable('firewall_ruleset_address_objects'))) {
    await database.schema.createTable('firewall_ruleset_address_objects', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('firewall_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      // host | range | subnet | fqdn | wildcard | group | any
      table.string('type', 30).nullable()
      table.string('value', 500).nullable()
      table.json('members').nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_firewall_ruleset_address_objects_ruleset')
    })
  }

  if (!(await database.schema.hasTable('firewall_ruleset_service_objects'))) {
    await database.schema.createTable('firewall_ruleset_service_objects', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('firewall_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.string('protocol', 30).nullable()
      table.string('port_range', 100).nullable()
      table.json('members').nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_firewall_ruleset_service_objects_ruleset')
    })
  }

  if (!(await database.schema.hasTable('firewall_ruleset_rules'))) {
    await database.schema.createTable('firewall_ruleset_rules', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('firewall_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.string('rule_type', 30).nullable()
      table.integer('sort_order').unsigned().notNullable().defaultTo(0)
      // allow | deny | drop | reject | other vendor-specific verbs
      table.string('action', 30).notNullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.boolean('logging').notNullable().defaultTo(false)
      table.text('description').nullable()
      // Match criteria are simple name/CIDR lists (not a boolean condition tree) — this is how every major
      // vendor's rule base actually models a security policy entry, unlike LB iRule/policy conditions.
      table.json('source_zones').nullable()
      table.json('destination_zones').nullable()
      table.json('source_addresses').nullable()
      table.json('destination_addresses').nullable()
      table.json('services').nullable()
      table.json('applications').nullable()
      table.json('users').nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_firewall_ruleset_rules_ruleset')
      table.index(['ruleset_id', 'sort_order'], 'idx_firewall_ruleset_rules_order')
    })
  }

  if (!(await database.schema.hasTable('firewall_ruleset_nat_rules'))) {
    await database.schema.createTable('firewall_ruleset_nat_rules', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('firewall_rulesets').onDelete('CASCADE')
      table.string('external_id', 200).notNullable()
      table.string('name', 200).notNullable()
      table.integer('sort_order').unsigned().notNullable().defaultTo(0)
      // source | destination | static | other vendor-specific NAT verbs
      table.string('nat_type', 30).nullable()
      table.string('source_zone', 200).nullable()
      table.string('destination_zone', 200).nullable()
      table.string('original_source', 300).nullable()
      table.string('original_destination', 300).nullable()
      table.string('original_service', 200).nullable()
      table.string('translated_source', 300).nullable()
      table.string('translated_destination', 300).nullable()
      table.string('translated_service', 200).nullable()
      table.json('extra_attributes').nullable()
      table.index(['ruleset_id'], 'idx_firewall_ruleset_nat_rules_ruleset')
    })
  }

  if (await database.schema.hasTable('target_landing_zones')) {
    // Replaced by the resource-group-only landing zone model.
    await database.schema.dropTable('target_landing_zones')
  }
  if (!(await database.schema.hasTable('landing_zone_resource_groups'))) {
    await database.schema.createTable('landing_zone_resource_groups', (table) => {
      table.bigIncrements('id').primary()
      table.string('subscription_id', 64).notNullable()
      table.string('subscription_name', 200).notNullable().defaultTo('')
      table.string('resource_group_name', 90).notNullable()
      table.text('resource_group_id').notNullable()
      table.string('resource_group_id_hash', 64).notNullable().unique()
      table.string('source', 20).notNullable().defaultTo('Manual')
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
  }
  if (!(await database.schema.hasColumn('landing_zone_resource_groups', 'subscription_name'))) {
    await database.schema.alterTable('landing_zone_resource_groups', (table) => {
      table.string('subscription_name', 200).notNullable().defaultTo('')
    })
  }

  if (!(await database.schema.hasTable('landing_zone_networks'))) {
    await database.schema.createTable('landing_zone_networks', (table) => {
      table.bigIncrements('id').primary()
      table.string('subscription_id', 64).notNullable()
      table.string('network_resource_group', 90).notNullable()
      table.string('virtual_network', 80).notNullable()
      table.string('virtual_network_ip_segment', 64).notNullable()
      table.string('subnet', 80).notNullable()
      table.string('subnet_ip_segment', 64).notNullable()
      table.string('network_security_group', 80).notNullable().defaultTo('')
      table.string('network_key_hash', 64).notNullable().unique()
      table.string('source', 20).notNullable().defaultTo('Manual')
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
  }

  if (!(await database.schema.hasTable('sprint_server_landing_zone_mappings'))) {
    await database.schema.createTable('sprint_server_landing_zone_mappings', (table) => {
      table.bigIncrements('id').primary()
      table.string('server_name', 300).notNullable().unique('uq_sprint_server_landing_zone_mapping_server')
      table.integer('sprint_sequence').unsigned().notNullable()
      table.string('subscription_id', 64).nullable()
      table.string('subscription_name', 200).nullable()
      table.text('resource_group_id').nullable()
      table.string('network_resource_group', 90).nullable()
      table.string('virtual_network', 80).nullable()
      table.string('subnet', 80).nullable()
      table.string('network_security_group', 80).nullable()
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
      table.index(['sprint_sequence'], 'idx_sprint_server_landing_zone_mapping_sprint')
    })
  }

  const mappingColumns = await database('information_schema.columns')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', 'sprint_server_landing_zone_mappings')
    .select({ name: 'column_name', nullable: 'is_nullable' }) as Array<{ name: string; nullable: string }>
  const nonNullableMappingColumns = new Set(mappingColumns.filter((column) => column.nullable === 'NO').map((column) => column.name))
  for (const [column, length] of [['subscription_id', 64], ['subscription_name', 200], ['network_resource_group', 90], ['virtual_network', 80], ['subnet', 80], ['network_security_group', 80]] as const) {
    if (!nonNullableMappingColumns.has(column)) continue
    await database.schema.alterTable('sprint_server_landing_zone_mappings', (table) => {
      table.string(column, length).nullable().alter()
    })
  }
  if (nonNullableMappingColumns.has('resource_group_id')) await database.schema.alterTable('sprint_server_landing_zone_mappings', (table) => {
    table.text('resource_group_id').nullable().alter()
  })

  if (!(await database.schema.hasTable('landing_zone_platform'))) {
    await database.schema.createTable('landing_zone_platform', (table) => {
      table.integer('id').unsigned().primary()
      table.string('network_connectivity', 200).notNullable().defaultTo('')
      table.string('network_topology', 200).notNullable().defaultTo('')
      table.string('firewall', 200).notNullable().defaultTo('')
      table.string('dns', 200).notNullable().defaultTo('')
      table.string('primary_region', 100).notNullable().defaultTo('')
      table.string('secondary_region', 100).notNullable().defaultTo('')
      table.string('availability_strategy', 200).notNullable().defaultTo('')
      table.string('identity_domain_controller', 200).notNullable().defaultTo('')
      table.string('monitoring_solution', 200).notNullable().defaultTo('')
      table.string('backup_solution', 200).notNullable().defaultTo('')
      table.string('endpoint_protection_solution', 200).notNullable().defaultTo('')
      table.string('siem_solution', 200).notNullable().defaultTo('')
      table.string('patch_management', 200).notNullable().defaultTo('')
      table.text('notes').nullable()
      table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    })
    await database('landing_zone_platform').insert({ id: 1 })
  }

  if (!(await database.schema.hasColumn('landing_zone_platform', 'network_topology'))) {
    await database.schema.alterTable('landing_zone_platform', (table) => {
      table.string('network_topology', 200).notNullable().defaultTo('')
    })
  }

}

// Only run the CLI flow (which closes the pool) when executed directly, not when imported.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  migrateSchema()
    .then(() => console.log('MySQL schema is ready.'))
    .catch((error) => { console.error(error); process.exitCode = 1 })
    .finally(closeDatabase)
}