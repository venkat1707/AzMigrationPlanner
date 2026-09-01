// Generic schema-definition reconciliation engine used by migrate.ts.
//
// The rest of migrate.ts describes each table's *intended final shape* once, using the same
// knex-like `(table) => { table.string(...)... }` callback style it already used for `createTable`.
// This module replays that same callback through a "recording" builder (which never touches the
// database) to capture the intended columns/indexes/foreign keys/primary key, then compares that
// intended shape against what MySQL's `information_schema` reports for the live table and issues
// corrective ALTER TABLE statements for any column type/nullability/default, index, foreign key, or
// primary key drift it finds — not just presence/absence.
//
// Safety notes:
//  - Auto-incrementing primary key columns (bigIncrements/increments) are never altered or rebuilt;
//    only their existence is checked. Altering an auto_increment primary key is high-risk and these
//    columns never legitimately change shape after creation.
//  - Columns/indexes/foreign keys that exist live but are NOT declared are only logged, never
//    dropped automatically — this engine only adds/corrects, it never silently removes things a
//    caller didn't ask it to.
import type { Knex } from 'knex'

export type SqlColumnType =
  | { kind: 'bigIncrements' }
  | { kind: 'increments' }
  | { kind: 'integer'; unsigned: boolean }
  | { kind: 'bigInteger'; unsigned: boolean }
  | { kind: 'string'; length: number }
  | { kind: 'text'; textType: 'text' | 'mediumtext' | 'longtext' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'dateTime' }
  | { kind: 'decimal'; precision: number; scale: number }
  | { kind: 'json' }

export type DefaultValue =
  | { kind: 'none' }
  | { kind: 'now' }
  | { kind: 'literal'; value: string | number | boolean }

export interface ForeignKeyDef {
  column: string
  refTable: string
  refColumn: string
  onDelete?: string
  onUpdate?: string
}

export interface ColumnDef {
  name: string
  type: SqlColumnType
  nullable: boolean
  defaultValue: DefaultValue
}

export interface IndexDef {
  name: string
  columns: string[]
  unique: boolean
}

export interface TableDef {
  name: string
  columns: ColumnDef[]
  primaryKey?: string[]
  indexes: IndexDef[]
  foreignKeys: ForeignKeyDef[]
}

const AUTO_INCREMENT_KINDS = new Set<SqlColumnType['kind']>(['bigIncrements', 'increments'])

class RecordingColumnBuilder {
  private pendingForeignKey?: Partial<ForeignKeyDef>

  constructor(private readonly col: ColumnDef, private readonly table: RecordingTableBuilder) {}

  unsigned(): this {
    if (this.col.type.kind === 'integer' || this.col.type.kind === 'bigInteger') this.col.type.unsigned = true
    return this
  }
  notNullable(): this { this.col.nullable = false; return this }
  nullable(): this { this.col.nullable = true; return this }
  defaultTo(value: unknown): this {
    if (value !== null && typeof value === 'object') {
      // knex raw expressions (e.g. database.fn.now()) — the only raw default used in this codebase.
      this.col.defaultValue = { kind: 'now' }
    } else {
      this.col.defaultValue = { kind: 'literal', value: value as string | number | boolean }
    }
    return this
  }
  primary(): this { this.table.primaryKey = [...(this.table.primaryKey ?? []), this.col.name]; return this }
  unique(indexName?: string): this {
    this.table.indexes.push({ name: indexName ?? `${this.table.name}_${this.col.name}_unique`, columns: [this.col.name], unique: true })
    return this
  }
  index(indexName?: string): this {
    this.table.indexes.push({ name: indexName ?? `${this.table.name}_${this.col.name}_index`, columns: [this.col.name], unique: false })
    return this
  }
  references(refColumn: string): this { this.pendingForeignKey = { column: this.col.name, refColumn }; return this }
  inTable(refTable: string): this {
    if (this.pendingForeignKey) {
      this.pendingForeignKey.refTable = refTable
      this.table.foreignKeys.push(this.pendingForeignKey as ForeignKeyDef)
    }
    return this
  }
  onDelete(rule: string): this { if (this.pendingForeignKey) this.pendingForeignKey.onDelete = rule; return this }
  onUpdate(rule: string): this { if (this.pendingForeignKey) this.pendingForeignKey.onUpdate = rule; return this }
  alter(): this { return this }
}

class RecordingTableBuilder {
  columns: ColumnDef[] = []
  primaryKey?: string[]
  indexes: IndexDef[] = []
  foreignKeys: ForeignKeyDef[] = []

  constructor(public readonly name: string) {}

  private addColumn(name: string, type: SqlColumnType): RecordingColumnBuilder {
    const col: ColumnDef = { name, type, nullable: true, defaultValue: { kind: 'none' } }
    this.columns.push(col)
    return new RecordingColumnBuilder(col, this)
  }

  bigIncrements(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'bigIncrements' }) }
  increments(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'increments' }) }
  integer(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'integer', unsigned: false }) }
  bigInteger(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'bigInteger', unsigned: false }) }
  string(name: string, length = 255): RecordingColumnBuilder { return this.addColumn(name, { kind: 'string', length }) }
  text(name: string, textType: 'text' | 'mediumtext' | 'longtext' = 'text'): RecordingColumnBuilder {
    return this.addColumn(name, { kind: 'text', textType })
  }
  boolean(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'boolean' }) }
  date(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'date' }) }
  dateTime(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'dateTime' }) }
  decimal(name: string, precision = 8, scale = 2): RecordingColumnBuilder { return this.addColumn(name, { kind: 'decimal', precision, scale }) }
  json(name: string): RecordingColumnBuilder { return this.addColumn(name, { kind: 'json' }) }

  primary(columns: string[]): this { this.primaryKey = columns; return this }
  unique(columns: string[], opts?: { indexName?: string }): this {
    this.indexes.push({ name: opts?.indexName ?? `${this.name}_${columns.join('_')}_unique`, columns, unique: true })
    return this
  }
  index(columns: string[], name?: string): this {
    this.indexes.push({ name: name ?? `${this.name}_${columns.join('_')}_index`, columns, unique: false })
    return this
  }
  foreign(column: string, constraintName?: string): { references: (refColumn: string) => { inTable: (refTable: string) => { onDelete: (r: string) => unknown; onUpdate: (r: string) => unknown } } } {
    const fk: ForeignKeyDef = { column, refTable: '', refColumn: '' }
    this.foreignKeys.push(fk)
    void constraintName
    return {
      references: (refColumn: string) => {
        fk.refColumn = refColumn
        return {
          inTable: (refTable: string) => {
            fk.refTable = refTable
            return {
              onDelete: (rule: string) => { fk.onDelete = rule; return this },
              onUpdate: (rule: string) => { fk.onUpdate = rule; return this },
            }
          },
        }
      },
    }
  }
}

// Records the intended final shape of a table by replaying the same builder callback used elsewhere
// for real `knex.schema.createTable(...)` calls, without touching the database.
export function recordTableDefinition(name: string, build: (table: Knex.CreateTableBuilder) => void): TableDef {
  const recorder = new RecordingTableBuilder(name)
  build(recorder as unknown as Knex.CreateTableBuilder)
  return { name, columns: recorder.columns, primaryKey: recorder.primaryKey, indexes: recorder.indexes, foreignKeys: recorder.foreignKeys }
}

function expectedColumnType(type: SqlColumnType): string {
  switch (type.kind) {
    case 'bigIncrements': return 'bigint unsigned'
    case 'increments': return 'int unsigned'
    case 'integer': return type.unsigned ? 'int unsigned' : 'int'
    case 'bigInteger': return type.unsigned ? 'bigint unsigned' : 'bigint'
    case 'string': return `varchar(${type.length})`
    case 'text': return type.textType
    case 'boolean': return 'tinyint(1)'
    case 'date': return 'date'
    case 'dateTime': return 'datetime'
    case 'decimal': return `decimal(${type.precision},${type.scale})`
    case 'json': return 'json'
  }
}

function defaultValueMatches(expected: DefaultValue, liveDefault: string | null): boolean {
  if (expected.kind === 'none') return liveDefault === null
  if (expected.kind === 'now') return liveDefault !== null && /^current_timestamp/i.test(liveDefault)
  if (liveDefault === null) return false
  const { value } = expected
  if (typeof value === 'boolean') return liveDefault === (value ? '1' : '0')
  if (typeof value === 'number') return Number(liveDefault) === value
  const unquoted = liveDefault.replace(/^'(.*)'$/, '$1')
  return unquoted === String(value)
}

function applyColumnToBuilder(
  database: Knex,
  table: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  col: ColumnDef,
  mode: 'add' | 'alter',
): void {
  let builder: Knex.ColumnBuilder
  switch (col.type.kind) {
    case 'bigIncrements': builder = table.bigIncrements(col.name); break
    case 'increments': builder = table.increments(col.name); break
    case 'integer': builder = table.integer(col.name); if (col.type.unsigned) builder = builder.unsigned(); break
    case 'bigInteger': builder = table.bigInteger(col.name); if (col.type.unsigned) builder = builder.unsigned(); break
    case 'string': builder = table.string(col.name, col.type.length); break
    case 'text': builder = table.text(col.name, col.type.textType === 'text' ? undefined : col.type.textType); break
    case 'boolean': builder = table.boolean(col.name); break
    case 'date': builder = table.date(col.name); break
    case 'dateTime': builder = table.dateTime(col.name); break
    case 'decimal': builder = table.decimal(col.name, col.type.precision, col.type.scale); break
    case 'json': builder = table.json(col.name); break
  }
  builder = col.nullable ? builder.nullable() : builder.notNullable()
  if (col.defaultValue.kind === 'literal') builder = builder.defaultTo(col.defaultValue.value)
  if (col.defaultValue.kind === 'now') builder = builder.defaultTo(database.fn.now())
  if (mode === 'alter') builder = builder.alter()
}

interface LiveColumn {
  name: string
  columnType: string
  nullable: boolean
  defaultValue: string | null
}

interface LiveIndex {
  columns: string[]
  unique: boolean
}

interface LiveForeignKey {
  constraintName: string
  column: string
  refTable: string
  refColumn: string
  onDelete: string
  onUpdate: string
}

export interface ReconcileChanges {
  columnsAdded: string[]
  columnsAltered: string[]
  indexesAdded: string[]
  indexesAltered: string[]
  foreignKeysAdded: string[]
  foreignKeysAltered: string[]
  primaryKeyRebuilt: boolean
}

function emptyChanges(): ReconcileChanges {
  return { columnsAdded: [], columnsAltered: [], indexesAdded: [], indexesAltered: [], foreignKeysAdded: [], foreignKeysAltered: [], primaryKeyRebuilt: false }
}

export interface ReconcileDeps {
  database: Knex
  log: (message: string) => void
}

// Compares `def` (the intended final shape) against what MySQL currently reports for `def.name`
// and issues corrective ALTER TABLE statements for any drift found. Assumes the table already exists.
export async function reconcileTableDefinition(def: TableDef, { database, log }: ReconcileDeps): Promise<ReconcileChanges> {
  const changes = emptyChanges()
  const tableName = def.name

  const liveColumnRows = await database('information_schema.columns')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', tableName)
    .select({ name: 'column_name', columnType: 'column_type', isNullable: 'is_nullable', defaultValue: 'column_default' }) as Array<{
      name: string; columnType: string; isNullable: string; defaultValue: string | null
    }>
  const liveColumns = new Map<string, LiveColumn>(
    liveColumnRows.map((row) => [row.name, { name: row.name, columnType: row.columnType, nullable: row.isNullable === 'YES', defaultValue: row.defaultValue }]),
  )

  for (const col of def.columns) {
    const live = liveColumns.get(col.name)
    if (!live) {
      log(`schema drift: ${tableName}.${col.name} is missing — adding it`)
      await database.schema.alterTable(tableName, (table) => applyColumnToBuilder(database, table, col, 'add'))
      changes.columnsAdded.push(col.name)
      continue
    }
    if (AUTO_INCREMENT_KINDS.has(col.type.kind)) continue // never alter auto-increment primary key columns
    const expectedType = expectedColumnType(col.type)
    const typeMatches = expectedType === live.columnType.toLowerCase()
    const nullableMatches = col.nullable === live.nullable
    const defaultMatches = defaultValueMatches(col.defaultValue, live.defaultValue)
    if (!typeMatches || !nullableMatches || !defaultMatches) {
      log(
        `schema drift: ${tableName}.${col.name} definition differs (expected ${expectedType}${col.nullable ? ' NULL' : ' NOT NULL'}, `
        + `found ${live.columnType}${live.nullable ? ' NULL' : ' NOT NULL'}) — correcting it`,
      )
      await database.schema.alterTable(tableName, (table) => applyColumnToBuilder(database, table, col, 'alter'))
      changes.columnsAltered.push(col.name)
    }
  }
  const declaredColumnNames = new Set(def.columns.map((col) => col.name))
  for (const liveName of liveColumns.keys()) {
    if (!declaredColumnNames.has(liveName)) log(`schema note: ${tableName}.${liveName} exists live but is not in the current definition (left untouched)`)
  }

  const statsRows = await database('information_schema.statistics')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', tableName)
    .orderBy('seq_in_index')
    .select({ indexName: 'index_name', columnName: 'column_name', nonUnique: 'non_unique' }) as Array<{
      indexName: string; columnName: string; nonUnique: number
    }>
  const liveIndexes = new Map<string, LiveIndex>()
  let livePrimaryKeyColumns: string[] = []
  for (const row of statsRows) {
    if (row.indexName === 'PRIMARY') { livePrimaryKeyColumns.push(row.columnName); continue }
    const existing = liveIndexes.get(row.indexName)
    if (existing) existing.columns.push(row.columnName)
    else liveIndexes.set(row.indexName, { columns: [row.columnName], unique: Number(row.nonUnique) === 0 })
  }

  for (const idx of def.indexes) {
    const live = liveIndexes.get(idx.name)
    if (!live) {
      log(`schema drift: index ${idx.name} on ${tableName} is missing — adding it`)
      await database.schema.alterTable(tableName, (table) => {
        if (idx.unique) table.unique(idx.columns, { indexName: idx.name })
        else table.index(idx.columns, idx.name)
      })
      changes.indexesAdded.push(idx.name)
      continue
    }
    const columnsMatch = live.columns.join(',') === idx.columns.join(',')
    if (!columnsMatch || live.unique !== idx.unique) {
      log(`schema drift: index ${idx.name} on ${tableName} covers different columns/uniqueness than declared — rebuilding it`)
      await database.schema.alterTable(tableName, (table) => {
        if (live.unique) table.dropUnique(live.columns, idx.name)
        else table.dropIndex(live.columns, idx.name)
      })
      await database.schema.alterTable(tableName, (table) => {
        if (idx.unique) table.unique(idx.columns, { indexName: idx.name })
        else table.index(idx.columns, idx.name)
      })
      changes.indexesAltered.push(idx.name)
    }
  }
  const declaredIndexNames = new Set(def.indexes.map((idx) => idx.name))
  for (const liveName of liveIndexes.keys()) {
    if (!declaredIndexNames.has(liveName)) log(`schema note: index ${liveName} on ${tableName} exists live but is not in the current definition (left untouched)`)
  }

  if (def.primaryKey && def.primaryKey.length > 0) {
    const declaredIsAutoIncrement = def.columns.some((col) => def.primaryKey!.includes(col.name) && AUTO_INCREMENT_KINDS.has(col.type.kind))
    if (!declaredIsAutoIncrement && livePrimaryKeyColumns.join(',') !== def.primaryKey.join(',')) {
      log(`schema drift: ${tableName} primary key is (${livePrimaryKeyColumns.join(', ') || 'none'}), expected (${def.primaryKey.join(', ')}) — rebuilding it`)
      const quotedColumns = def.primaryKey.map((col) => `\`${col}\``).join(', ')
      await database.raw(`ALTER TABLE \`${tableName}\` DROP PRIMARY KEY, ADD PRIMARY KEY (${quotedColumns})`)
      changes.primaryKeyRebuilt = true
    }
  }

  if (def.foreignKeys.length > 0) {
    const fkRows = await database('information_schema.key_column_usage as kcu')
      .join('information_schema.referential_constraints as rc', function joinOn(this: Knex.JoinClause) {
        this.on('rc.constraint_schema', '=', 'kcu.table_schema')
          .andOn('rc.constraint_name', '=', 'kcu.constraint_name')
          .andOn('rc.table_name', '=', 'kcu.table_name')
      })
      .whereRaw('kcu.table_schema = DATABASE()')
      .where('kcu.table_name', tableName)
      .whereNotNull('kcu.referenced_table_name')
      .select({
        constraintName: 'kcu.constraint_name', column: 'kcu.column_name', refTable: 'kcu.referenced_table_name',
        refColumn: 'kcu.referenced_column_name', onDelete: 'rc.delete_rule', onUpdate: 'rc.update_rule',
      }) as Array<{ constraintName: string; column: string; refTable: string; refColumn: string; onDelete: string; onUpdate: string }>
    const liveForeignKeysByColumn = new Map<string, LiveForeignKey>(fkRows.map((row) => [row.column, row]))

    for (const fk of def.foreignKeys) {
      const live = liveForeignKeysByColumn.get(fk.column)
      if (!live) {
        log(`schema drift: foreign key on ${tableName}.${fk.column} -> ${fk.refTable}.${fk.refColumn} is missing — adding it`)
        await database.schema.alterTable(tableName, (table) => {
          let builder = table.foreign(fk.column).references(fk.refColumn).inTable(fk.refTable)
          if (fk.onDelete) builder = builder.onDelete(fk.onDelete)
          if (fk.onUpdate) builder = builder.onUpdate(fk.onUpdate)
        })
        changes.foreignKeysAdded.push(fk.column)
        continue
      }
      const targetMatches = live.refTable === fk.refTable && live.refColumn === fk.refColumn
      const onDeleteMatches = !fk.onDelete || live.onDelete.toUpperCase() === fk.onDelete.toUpperCase()
      const onUpdateMatches = !fk.onUpdate || live.onUpdate.toUpperCase() === fk.onUpdate.toUpperCase()
      if (!targetMatches || !onDeleteMatches || !onUpdateMatches) {
        log(
          `schema drift: foreign key on ${tableName}.${fk.column} points to ${live.refTable}.${live.refColumn} `
          + `(ON DELETE ${live.onDelete}) but should point to ${fk.refTable}.${fk.refColumn} (ON DELETE ${fk.onDelete ?? live.onDelete}) — correcting it`,
        )
        await database.schema.alterTable(tableName, (table) => {
          table.dropForeign([fk.column], live.constraintName)
        })
        await database.schema.alterTable(tableName, (table) => {
          let builder = table.foreign(fk.column).references(fk.refColumn).inTable(fk.refTable)
          if (fk.onDelete) builder = builder.onDelete(fk.onDelete)
          if (fk.onUpdate) builder = builder.onUpdate(fk.onUpdate)
        })
        changes.foreignKeysAltered.push(fk.column)
      }
    }
  }

  return changes
}
