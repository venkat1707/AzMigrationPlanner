import { pathToFileURL } from 'node:url'
import type { Knex } from 'knex'
import { closeDatabase, database } from './db.js'
import { refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { seedDatabaseServerEvidence } from './database-server-evidence.js'
import { refreshDependencyDirections } from './dependency-direction.js'
import { refreshDependencySummary } from './dependency-summary.js'
import { recordTableDefinition, reconcileTableDefinition } from './schema-reconcile.js'

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

function log(message: string): void {
  console.log(`[migrate] ${new Date().toISOString()} ${message}`)
}

let schemaChecksLogged = 0
let schemaChangesLogged = 0

// Wraps a fresh knex schema builder so every hasTable/hasColumn/createTable/alterTable/dropTable call
// prints what it checked and whether it had to make a change. A new builder is fetched on every call,
// exactly mirroring how this file already used `database.schema.xxx()` one statement at a time.
function S(): Knex.SchemaBuilder {
  const builder = database.schema
  return new Proxy(builder, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver)
      if (typeof original !== 'function') return original
      return (...args: unknown[]) => {
        const label = args.filter((value) => typeof value === 'string').join(', ')
        const call = `schema.${String(property)}('${label}')`
        const isCheck = property === 'hasTable' || property === 'hasColumn'
        if (isCheck) schemaChecksLogged += 1
        log(`${call} — checking...`)
        const outcome = original.apply(target, args) as Promise<unknown>
        return outcome.then((value) => {
          if (isCheck) {
            log(`${call} -> ${value ? 'already exists, no change needed' : 'does NOT exist yet'}`)
          } else {
            schemaChangesLogged += 1
            log(`${call} -> applied successfully`)
          }
          return value
        }, (error: unknown) => {
          log(`${call} -> FAILED: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        })
      }
    },
  })
}

// Wraps database.raw so every DDL/backfill statement is logged before and after it runs.
async function runRaw(sql: string, bindings?: readonly unknown[]): Promise<unknown> {
  const summary = sql.trim().split('\n').map((line) => line.trim()).find(Boolean) ?? sql.trim()
  log(`raw SQL: ${summary} ...`)
  try {
    const result = bindings ? await database.raw(sql, bindings as never) : await database.raw(sql)
    schemaChangesLogged += 1
    log(`raw SQL: ${summary} ... -> applied successfully`)
    return result
  } catch (error) {
    log(`raw SQL: ${summary} ... -> FAILED: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

// Ensures `name` exists (creating it from `build` if missing, exactly as before), then — regardless of
// whether it was just created or already existed — records `build`'s intended final shape and compares
// it against what MySQL currently reports for the table, correcting any column type/nullability/default,
// index, foreign key, or primary key drift it finds. See schema-reconcile.ts for the comparison logic.
async function defineTable(
  name: string,
  build: (table: Knex.CreateTableBuilder) => void,
): Promise<{ created: boolean; changes: Awaited<ReturnType<typeof reconcileTableDefinition>> }> {
  const created = !(await S().hasTable(name))
  if (created) {
    await S().createTable(name, build)
  }
  const definition = recordTableDefinition(name, build)
  const changes = await reconcileTableDefinition(definition, { database, log })
  const changeCount = changes.columnsAdded.length + changes.columnsAltered.length + changes.indexesAdded.length
    + changes.indexesAltered.length + changes.foreignKeysAdded.length + changes.foreignKeysAltered.length
    + (changes.primaryKeyRebuilt ? 1 : 0)
  schemaChecksLogged += 1
  schemaChangesLogged += changeCount
  return { created, changes }
}

export async function migrateSchema(): Promise<void> {
  const startedAt = Date.now()
  schemaChecksLogged = 0
  schemaChangesLogged = 0
  log(`Starting MySQL schema migration against ${process.env.MYSQL_HOST ?? 'unknown host'} / ${process.env.MYSQL_DATABASE ?? 'unknown database'} ...`)

  const { created: authSettingsCreated } = await defineTable('app_auth_settings', (table) => {
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
  if (authSettingsCreated) {
    log('Seeding default row into app_auth_settings...')
    await database('app_auth_settings').insert({ id: 1 })
  }

  await defineTable('app_users', (table) => {
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

  await defineTable('app_sessions', (table) => {
    table.string('id', 64).primary()
    table.bigInteger('user_id').unsigned().notNullable().references('id').inTable('app_users').onDelete('CASCADE')
    table.string('csrf_token', 64).notNullable()
    table.dateTime('expires_at').notNullable()
    table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
    table.index(['user_id'], 'idx_app_sessions_user')
    table.index(['expires_at'], 'idx_app_sessions_expiry')
  })

  await defineTable('app_auth_flows', (table) => {
    table.string('state', 64).primary()
    table.string('nonce', 64).notNullable()
    table.string('code_verifier', 128).nullable()
    table.dateTime('expires_at').notNullable()
    table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
    table.index(['expires_at'], 'idx_app_auth_flows_expiry')
  })

  await defineTable('import_runs', (table) => {
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

  const { changes: dependencyRecordsChanges } = await defineTable('dependency_records', (table) => {
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
    table.string('protocol', 10).nullable()
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
  if (dependencyRecordsChanges.columnsAdded.includes('direction')) {
    log('Backfilling dependency_records.direction for existing rows...')
    await refreshDependencyDirections()
  }

  if (!(await S().hasColumn('dependency_records', 'source_ip'))) {
    throw new Error('dependency_records is missing source_ip')
  }

  await defineTable('dns_records', (table) => {
    table.bigIncrements('id').primary()
    table.string('query', 300).notNullable()
    table.string('ip_address', 64).notNullable()
    table.date('observed_date').nullable()
    table.string('source', 30).notNullable().defaultTo('Corelight')
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    table.unique(['query', 'ip_address'], { indexName: 'uq_dns_records_query_ip' })
    table.index(['ip_address'], 'idx_dns_records_ip')
  })

  // Vendor exports (F5, Citrix ADC, AWS ELB, Azure LB, NGINX, HAProxy, Kemp, ...) differ in schema, so the
  // original JSON/XML/CSV document is kept verbatim in raw_content rather than normalized into columns.
  await defineTable('load_balancer_rule_imports', (table) => {
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

  const { created: databaseServerEvidenceCreated } = await defineTable('database_server_evidence', (table) => {
    table.string('evidence_type', 10).notNullable()
    table.string('value', 300).notNullable()
    table.primary(['evidence_type', 'value'])
  })
  if (databaseServerEvidenceCreated) {
    log('Seeding database_server_evidence reference data...')
    await seedDatabaseServerEvidence()
  }

  // Legacy index names that earlier code once relied on and has since replaced with the names above —
  // still explicitly retired here rather than folded into the definition comparison, since this is a
  // one-time cleanup of historical names rather than part of the table's current intended shape.
  const dependencyIndexes = await database('information_schema.statistics')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', 'dependency_records')
    .distinct({ indexName: 'index_name' }) as Array<{ indexName: string }>
  const dependencyIndexNames = new Set(dependencyIndexes.map(({ indexName }) => indexName))
  const existingRedundantIndexes = redundantDependencyIndexNames.filter((indexName) => dependencyIndexNames.has(indexName))
  if (existingRedundantIndexes.length > 0) {
    const clauses = existingRedundantIndexes.map(() => 'DROP INDEX ??').join(', ')
    await runRaw(`ALTER TABLE dependency_records ${clauses}`, existingRedundantIndexes)
  }

  if (await S().hasTable('application_inventory')) {
    await S().dropTable('application_inventory')
  }

  await defineTable('applications', (table) => {
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

  // A UNIQUE index can't be added while duplicate server_name values exist, so dedupe defensively
  // before the definition comparison below tries to add uq_server_assessments_server_name.
  if (await S().hasTable('server_assessments')) {
    const assessmentIndexes = await database('information_schema.statistics')
      .whereRaw('table_schema = DATABASE()')
      .where({ table_name: 'server_assessments', index_name: 'uq_server_assessments_server_name' })
      .first()
    if (!assessmentIndexes) {
      await runRaw(`
        DELETE older
        FROM server_assessments AS older
        INNER JOIN server_assessments AS newer
          ON older.server_name = newer.server_name
         AND older.id < newer.id
      `)
    }
  }

  await defineTable('server_assessments', (table) => {
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

  await defineTable('environment_identification_rules', (table) => {
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

  log('Backfilling applications from legacy server_assessments.application values...')
  await runRaw(`
    INSERT INTO applications (name, description, source)
    SELECT application, MAX(application_description), 'Legacy'
    FROM server_assessments
    WHERE application IS NOT NULL AND TRIM(application) <> ''
    GROUP BY application
    ON DUPLICATE KEY UPDATE description = COALESCE(applications.description, VALUES(description))
  `)

  await defineTable('core_infrastructure_servers', (table) => {
    table.bigIncrements('id').primary()
    table.bigInteger('assessment_id').unsigned().nullable().references('id').inTable('server_assessments').onDelete('CASCADE')
    table.string('server_name', 300).notNullable()
    table.string('category', 100).notNullable()
    table.string('application', 500).nullable()
    table.string('environment_type', 100).nullable()
    table.string('operating_system_name', 500).nullable()
    table.string('os_version', 100).nullable()
    table.text('ip_address').nullable()
    table.string('migration_readiness', 100).nullable()
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    table.string('source', 20).notNullable().defaultTo('Assessment')
    table.index(['category', 'server_name'], 'idx_core_infrastructure_category_server')
    table.index(['source'], 'idx_core_infrastructure_source')
    table.index(['assessment_id'], 'idx_core_infrastructure_assessment')
    table.unique(['server_name', 'category'], { indexName: 'uq_core_infrastructure_server_category' })
  })
  // uq_core_infrastructure_assessment_category was replaced by uq_core_infrastructure_server_category —
  // explicitly retired here (rather than folded into the definition above) since it's a one-time
  // rename of a historical index name, not part of the table's current intended shape.
  const coreInfrastructureLegacyIndex = await database('information_schema.statistics')
    .whereRaw('table_schema = DATABASE()')
    .where({ table_name: 'core_infrastructure_servers', index_name: 'uq_core_infrastructure_assessment_category' })
    .first()
  if (coreInfrastructureLegacyIndex) {
    await S().alterTable('core_infrastructure_servers', (table) => {
      table.dropUnique(['assessment_id', 'category'], 'uq_core_infrastructure_assessment_category')
    })
  }

  await defineTable('core_infrastructure_networks', (table) => {
    table.string('network_type', 30).notNullable()
    table.string('ip_range', 100).notNullable()
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    table.primary(['network_type', 'ip_range'])
  })

  await defineTable('core_infrastructure_load_balancer_ips', (table) => {
    table.string('ip_address', 45).primary()
    table.string('source', 20).notNullable().defaultTo('Manual')
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
  })

  const coreInfrastructureCount = await database('core_infrastructure_servers').count({ count: 'id' }).first()
  if (Number(coreInfrastructureCount?.count ?? 0) === 0) {
    log('core_infrastructure_servers is empty — running the initial auto-detection refresh...')
    await refreshCoreInfrastructureSummary()
  }

  const { created: applicationServerMappingsCreated } = await defineTable('application_server_mappings', (table) => {
    table.bigIncrements('id').primary()
    table.string('server_name', 300).notNullable()
      .references('server_name').inTable('server_assessments').onUpdate('CASCADE').onDelete('CASCADE')
    table.string('application', 500).notNullable()
      .references('name').inTable('applications').onUpdate('CASCADE').onDelete('CASCADE')
    table.boolean('is_primary').notNullable().defaultTo(false)
    table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
    table.unique(['server_name', 'application'], { indexName: 'uq_application_server_mappings_pair' })
    table.index(['application'], 'idx_application_server_mappings_application')
    table.index(['server_name', 'is_primary'], 'idx_application_server_mappings_primary')
  })
  if (applicationServerMappingsCreated) {
    // Backfill: the existing single application column on each server becomes its primary mapping.
    log('Backfilling application_server_mappings from existing server_assessments rows...')
    await runRaw(`
      INSERT INTO application_server_mappings (server_name, application, is_primary)
      SELECT server_name, application, TRUE
      FROM server_assessments
      WHERE application IS NOT NULL AND TRIM(application) <> ''
    `)
  }

  await defineTable('dependency_summary', (table) => {
    table.integer('id').unsigned().primary()
    table.bigInteger('total_dependencies').unsigned().notNullable().defaultTo(0)
    table.bigInteger('total_connections').unsigned().notNullable().defaultTo(0)
    table.integer('source_servers').unsigned().notNullable().defaultTo(0)
    table.integer('destination_servers').unsigned().notNullable().defaultTo(0)
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
  })

  const { created: dependencySourceServersCreated } = await defineTable('dependency_source_servers', (table) => {
    table.string('server_name', 300).primary()
  })
  if (dependencySourceServersCreated) {
    log('Backfilling dependency_source_servers from dependency_records...')
    await database('dependency_source_servers').insert(
      database('dependency_records').distinct({ server_name: 'source_server_name' }).whereNotNull('source_server_name'),
    )
  }
  const { created: dependencyDestinationServersCreated } = await defineTable('dependency_destination_servers', (table) => {
    table.string('server_name', 300).primary()
  })
  if (dependencyDestinationServersCreated) {
    log('Backfilling dependency_destination_servers from dependency_records...')
    await database('dependency_destination_servers').insert(
      database('dependency_records').distinct({ server_name: 'destination_server_name' }).whereNotNull('destination_server_name'),
    )
  }

  if (!(await database('dependency_summary').where({ id: 1 }).first())) {
    log('dependency_summary row is missing — computing it now...')
    await refreshDependencySummary()
  }

  await defineTable('migration_wave_plans', (table) => {
    table.integer('id').unsigned().primary()
    table.json('plan_json').notNullable()
    table.dateTime('generated_at').notNullable()
    table.dateTime('saved_at').notNullable().defaultTo(database.fn.now())
  })

  await defineTable('migration_wave_plan_filters', (table) => {
    table.integer('id').unsigned().primary()
    table.json('filter_json').notNullable()
    table.json('considered_servers_json').notNullable()
    table.dateTime('saved_at').notNullable().defaultTo(database.fn.now())
  })

  await defineTable('task_comment_audit', (table) => {
    table.bigIncrements('id').primary()
    table.string('task_key', 1000).notNullable()
    table.string('task_type', 20).notNullable()
    table.text('comment').notNullable()
    table.bigInteger('actor_user_id').unsigned().nullable().references('id').inTable('app_users').onDelete('SET NULL')
    table.string('actor_display_name', 200).notNullable()
    table.dateTime('created_at').notNullable().defaultTo(database.fn.now())
    table.index(['task_key', 'created_at'], 'idx_task_comment_audit_task')
  })

  await defineTable('windows_services_ports', (table) => {
    table.bigIncrements('id').primary()
    table.string('windows_service', 100).notNullable()
    table.string('short_description', 500).notNullable()
    table.string('ports', 200).notNullable()
    table.string('network_protocol', 50).notNullable()
    table.string('application_protocol', 200).notNullable()
    table.index(['windows_service'], 'idx_windows_services_ports_service')
    table.index(['ports'], 'idx_windows_services_ports_ports')
  })

  await defineTable('agent_endpoints', (table) => {
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

  // Normalized, agent-parsed load balancer rulesets — the single source of truth for rule analysis,
  // kept separate from load_balancer_rule_imports (which only stores the raw document). Re-parsing an
  // import adds a new version rather than overwriting, so prior analysis stays reproducible.
  await defineTable('load_balancer_rulesets', (table) => {
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

  await defineTable('lb_ruleset_pools', (table) => {
    table.bigIncrements('id').primary()
    table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('load_balancer_rulesets').onDelete('CASCADE')
    table.string('external_id', 200).notNullable()
    table.string('name', 200).notNullable()
    table.string('load_balancing_method', 100).nullable()
    table.json('monitor_external_ids').nullable()
    table.json('extra_attributes').nullable()
    table.index(['ruleset_id'], 'idx_lb_ruleset_pools_ruleset')
  })

  await defineTable('lb_ruleset_pool_members', (table) => {
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

  await defineTable('lb_ruleset_monitors', (table) => {
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

  await defineTable('lb_ruleset_virtual_servers', (table) => {
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

  await defineTable('lb_ruleset_rules', (table) => {
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

  // Adjacency list so arbitrarily nested AND/OR/NOT condition trees (F5 iRule logic, NetScaler
  // compound expressions, Zscaler policy criteria) can be stored and rebuilt without a fixed depth limit.
  await defineTable('lb_ruleset_rule_conditions', (table) => {
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

  await defineTable('lb_ruleset_rule_actions', (table) => {
    table.bigIncrements('id').primary()
    table.bigInteger('rule_id').unsigned().notNullable().references('id').inTable('lb_ruleset_rules').onDelete('CASCADE')
    table.integer('sort_order').unsigned().notNullable().defaultTo(0)
    table.string('action_type', 100).notNullable()
    table.string('target', 300).nullable()
    table.json('parameters').nullable()
    table.json('extra_attributes').nullable()
    table.index(['rule_id'], 'idx_lb_ruleset_rule_actions_rule')
  })

  // Vendor exports (Palo Alto, Fortigate, Cisco ASA/IOS/Firepower, AWS Security Groups/NACLs, Check Point, ...)
  // differ in schema, so the original JSON/XML/CSV/Conf document is kept verbatim in raw_content rather than
  // normalized into columns. Mirrors load_balancer_rule_imports.
  await defineTable('firewall_rule_imports', (table) => {
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

  // Normalized, agent-parsed firewall rulesets — mirrors load_balancer_rulesets. Re-parsing an import
  // adds a new version rather than overwriting, so prior analysis stays reproducible.
  await defineTable('firewall_rulesets', (table) => {
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

  await defineTable('firewall_ruleset_zones', (table) => {
    table.bigIncrements('id').primary()
    table.bigInteger('ruleset_id').unsigned().notNullable().references('id').inTable('firewall_rulesets').onDelete('CASCADE')
    table.string('external_id', 200).notNullable()
    table.string('name', 200).notNullable()
    table.json('extra_attributes').nullable()
    table.index(['ruleset_id'], 'idx_firewall_ruleset_zones_ruleset')
  })

  await defineTable('firewall_ruleset_address_objects', (table) => {
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

  await defineTable('firewall_ruleset_service_objects', (table) => {
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

  await defineTable('firewall_ruleset_rules', (table) => {
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

  await defineTable('firewall_ruleset_nat_rules', (table) => {
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

  if (await S().hasTable('target_landing_zones')) {
    // Replaced by the resource-group-only landing zone model.
    await S().dropTable('target_landing_zones')
  }
  await defineTable('landing_zone_resource_groups', (table) => {
    table.bigIncrements('id').primary()
    table.string('subscription_id', 64).notNullable()
    table.string('subscription_name', 200).notNullable().defaultTo('')
    table.string('resource_group_name', 90).notNullable()
    table.text('resource_group_id').notNullable()
    table.string('resource_group_id_hash', 64).notNullable().unique()
    table.string('location', 50).notNullable().defaultTo('')
    table.string('source', 20).notNullable().defaultTo('Manual')
    table.dateTime('updated_at').notNullable().defaultTo(database.fn.now())
  })

  await defineTable('landing_zone_networks', (table) => {
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

  await defineTable('sprint_server_landing_zone_mappings', (table) => {
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
    table.string('ip_allocation', 10).notNullable().defaultTo('DYNAMIC')
    table.string('resiliency', 30).notNullable().defaultTo('')
    table.string('resiliency_details', 200).notNullable().defaultTo('')
    table.index(['sprint_sequence'], 'idx_sprint_server_landing_zone_mapping_sprint')
  })

  const { created: landingZonePlatformCreated } = await defineTable('landing_zone_platform', (table) => {
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
  if (landingZonePlatformCreated) {
    log('Seeding default row into landing_zone_platform...')
    await database('landing_zone_platform').insert({ id: 1 })
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(`Finished in ${elapsedSeconds}s — checked ${schemaChecksLogged} schema object(s), applied ${schemaChangesLogged} change(s).`)
  if (schemaChangesLogged === 0) {
    log('Result: schema was already fully up to date — no changes were necessary.')
  } else {
    log(`Result: applied ${schemaChangesLogged} schema change(s) successfully.`)
  }

}

// Only run the CLI flow (which closes the pool) when executed directly, not when imported.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  migrateSchema()
    .then(() => log('\u2705 MySQL schema is ready.'))
    .catch((error) => {
      log('\u274c MIGRATION FAILED — the schema may be partially updated. See the error below for the exact step that failed:')
      console.error(error)
      process.exitCode = 1
    })
    .finally(closeDatabase)
}